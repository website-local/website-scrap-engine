import {createRequire} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {load as cheerioLoad} from 'cheerio';
import type {CheerioStatic} from './types.js';

export interface HtmlParserOptions {
  /** Opt-in GroveDOM 0.1.2 Wasm support; Cheerio remains the default. */
  htmlParser?: 'cheerio' | 'grovedom';
  grovedom?: {
    /** Consumer-installed package, absolute module path or file URL. Default: grovedom. */
    module?: string;
    /** Idle Wasm instance limits, per process/worker. These do not limit active documents. */
    poolSize?: number;
    poolMaxBytes?: number;
  };
}

type OwnedDocument = CheerioStatic & {
  dispose(): void;
};

// The experimental backend implements the engine's Cheerio-shaped operations.
// This boundary does not promise arbitrary Cheerio plugins or raw domhandler APIs.
interface GroveModule {
  init(options: {heap: 'pool'; poolSize: number; poolMaxBytes: number}): void;
  load: typeof cheerioLoad;
}

interface GroveParser {
  module: string;
  poolSize: number;
  poolMaxBytes: number;
  load?: typeof cheerioLoad;
}

interface DocumentResource { meta: {doc?: CheerioStatic} }
interface DocumentScope {
  parser: GroveParser;
  documents: Set<OwnedDocument>;
  resources: Set<DocumentResource>;
  notifications: Set<Promise<void>>;
  closed: boolean;
}

const scopes = new AsyncLocalStorage<DocumentScope | undefined>();
const groveParsers = new Map<string, GroveParser>();

export function validateHtmlParserOptions(options: HtmlParserOptions): void {
  if (options.htmlParser !== undefined && options.htmlParser !== 'cheerio' && options.htmlParser !== 'grovedom') {
    throw new TypeError('Unknown htmlParser: ' + options.htmlParser);
  }
  const config = options.grovedom;
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('grovedom must be an options object');
  }
  if (config.module !== undefined && (typeof config.module !== 'string' || !config.module)) {
    throw new TypeError('grovedom.module must be a nonempty module name, absolute path or file URL');
  }
  for (const key of ['poolSize', 'poolMaxBytes'] as const) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) {
      throw new RangeError('grovedom.' + key + ' must be a nonnegative safe integer');
    }
  }
}

function groveParser(options: HtmlParserOptions): GroveParser {
  validateHtmlParserOptions(options);
  const config = options.grovedom;
  const specifier = config?.module ?? 'grovedom';
  const module = isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
  const poolSize = config?.poolSize ?? 8, poolMaxBytes = config?.poolMaxBytes ?? 16 * 1024 * 1024;
  let parser = groveParsers.get(module);
  if (!parser) {
    let resolved = module;
    try { resolved = import.meta.resolve(module); }
    catch { /* The synchronous loader also supports require-only packages. */ }
    try {
      // Match the synchronous loader's identity, including URL suffixes,
      // extensionless paths and symlinks, while retaining import conditions.
      const required = require.resolve(resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved);
      resolved = isAbsolute(required) ? pathToFileURL(required).href : required;
    } catch { /* Defer resolution errors until markup needs the parser. */ }
    parser = groveParsers.get(resolved);
    if (!parser) {
      parser = {module: resolved, poolSize, poolMaxBytes};
      groveParsers.set(resolved, parser);
    }
    groveParsers.set(module, parser);
  }
  if (parser.poolSize !== poolSize || parser.poolMaxBytes !== poolMaxBytes) {
    throw new Error('GroveDOM pool options must agree for the same module in one process/worker');
  }
  return parser;
}

function initializeGrove(parser: GroveParser): void {
  if (parser.load) return;
  const module = require(parser.module.startsWith('file:') ?
    fileURLToPath(parser.module) : parser.module) as GroveModule;
  if (typeof module.init !== 'function' || typeof module.load !== 'function') {
    throw new TypeError('Expected a GroveDOM module with init() and load()');
  }
  module.init({heap: 'pool', poolSize: parser.poolSize, poolMaxBytes: parser.poolMaxBytes});
  parser.load = module.load;
}

/** Own GroveDOM documents through all transformations AND final serialization/saving. */
export function withHtmlParser<T>(options: HtmlParserOptions, callback: () => T | Promise<T>): Promise<T> {
  validateHtmlParserOptions(options);
  const current = scopes.getStore();
  if (current?.closed) return Promise.reject(new Error('HTML document scope has finished'));
  if (options.htmlParser !== 'grovedom') {
    return current ? scopes.run(undefined, async () => callback()) : invoke(callback);
  }
  const parser = groveParser(options);
  if (current?.parser === parser) return invoke(callback);
  const scope: DocumentScope = {parser, documents: new Set(), resources: new Set(),
    notifications: new Set(), closed: false};
  return scopes.run(scope, async () => {
    let failed = false;
    let failure: unknown;
    let result!: T;
    const errors: unknown[] = [];
    try { result = await callback(); }
    catch (error) { failed = true; failure = error; }
    finally {
      // Error/admission notifications have synchronous callers. Their entire
      // listener chains, including further notifications, still own documents.
      while (scope.notifications.size) await Promise.allSettled(scope.notifications);
      scope.closed = true;
      for (const resource of scope.resources) {
        try {
          if (resource.meta.doc && scope.documents.has(resource.meta.doc as OwnedDocument)) {
            delete resource.meta.doc;
          }
        } catch (error) { errors.push(error); }
      }
      for (const document of scope.documents) {
        try { document.dispose(); } catch (error) { errors.push(error); }
      }
      scope.resources.clear();
      scope.documents.clear();
    }
    if (failed) throw failure;
    if (errors.length) throw new AggregateError(errors, 'HTML document disposal failed');
    return result;
  });
}

function invoke<T>(callback: () => T | Promise<T>): Promise<T> {
  try { return Promise.resolve(callback()); }
  catch (error) { return Promise.reject(error); }
}

/** A queued resource must not inherit its submitting parent's document lifetime. */
export function withResourceHtmlParser<T>(options: HtmlParserOptions, callback: () => Promise<T>): Promise<T> {
  return scopes.getStore() ? scopes.run(undefined, () => withHtmlParser(options, callback)) :
    withHtmlParser(options, callback);
}

/** Notifications can precede processing or outlive their submitting parent. */
export function withHtmlStatusChange(options: HtmlParserOptions, callback: () => Promise<void>): Promise<void> {
  const scope = scopes.getStore();
  // Setup failures must also honor the notification's Promise API.
  return invoke(() => scope?.closed || (!scope && options.htmlParser === 'grovedom') ?
    withResourceHtmlParser(options, callback) : callback());
}

/** Register resources so a retry cannot reuse a document disposed by its previous attempt. */
export function trackHtmlResource(resource: DocumentResource): void {
  const scope = scopes.getStore();
  if (scope?.closed) throw new Error('HTML document scope has finished');
  scope?.resources.add(resource);
}

/** Keep engine-tracked status callbacks inside their resource's ownership. */
export function trackHtmlStatusChange(pending: Promise<void>): Promise<void> {
  const scope = scopes.getStore();
  if (scope && !scope.closed) {
    scope.notifications.add(pending);
    const settled = () => { scope.notifications.delete(pending); };
    void pending.then(settled, settled);
  }
  return pending;
}

export function assertHtmlParserScope(options: HtmlParserOptions): void {
  if (options.htmlParser !== 'grovedom') return;
  const scope = scopes.getStore();
  if (!scope || scope.closed || scope.parser !== groveParser(options)) {
    throw new Error('GroveDOM operations require withHtmlParser() through serialization and saving');
  }
}

// Binary-only workers do not need an HTML parser. Keep the synchronous parser
// API while deferring its dependency graph until the first document is parsed.
const require = createRequire(import.meta.url);
let parser: typeof cheerioLoad | undefined;
let loading: Promise<void> | undefined;

/** Prepare the parser once before markup lifecycle hooks. */
export function prepareHtmlParser(options?: HtmlParserOptions): void | Promise<void> {
  if (options) assertHtmlParserScope(options);
  const scope = scopes.getStore();
  if (scope) {
    if (scope.closed) throw new Error('HTML document scope has finished');
    const parser = scope.parser;
    // loadHtml() is synchronous. Use the same loader here so concurrent first
    // loads cannot require an ESM graph whose async import is still pending.
    initializeGrove(parser);
    return;
  }
  if (parser) return;
  return loading ??= import('cheerio').then(module => { parser = module.load; });
}

export const load: typeof cheerioLoad = (...args) => {
  const scope = scopes.getStore();
  if (scope) {
    if (scope.closed) throw new Error('HTML document scope has finished');
    const parser = scope.parser;
    initializeGrove(parser);
    const document = parser.load!(...args) as OwnedDocument;
    if (typeof document.dispose !== 'function') throw new TypeError('Expected a disposable GroveDOM document');
    scope.documents.add(document);
    // Generated documents from hooks must join the same owning resource scope.
    document.load = (...args) => {
      if (scope.closed) throw new Error('HTML document scope has finished');
      return scopes.run(scope, () => load(...args));
    };
    return document;
  }
  parser ??= (require('cheerio') as {load: typeof cheerioLoad}).load;
  return parser(...args);
};
