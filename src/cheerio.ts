import {createRequire} from 'node:module';
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

export const groveParsers: Record<string, GroveParser> = {};

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
  let parser = groveParsers['$' + module];
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
    parser = groveParsers['$' + resolved];
    if (!parser) {
      parser = {module: resolved, poolSize, poolMaxBytes};
      groveParsers['$' + resolved] = parser;
    }
    groveParsers['$' + module] = parser;
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

/** Wait for this resource's status work, then release its document. */
export function disposeHtmlResource(resource: {meta: {doc?: CheerioStatic; statusChanges?: Promise<void>[]}}): void | Promise<void> {
  const pending = resource.meta.statusChanges;
  if (pending?.length) {
    return (async () => {
      // Listeners may enqueue more status changes while earlier ones await.
      for (let index = 0; index < pending.length; index++) await pending[index];
      resource.meta.statusChanges = undefined;
      return disposeHtmlResource(resource);
    })();
  }
  const document = resource.meta.doc as (CheerioStatic & {dispose?: () => void}) | undefined;
  if (!document) return;
  resource.meta.doc = undefined;
  document.dispose?.();
}

const require = createRequire(import.meta.url);
let parser: typeof cheerioLoad | undefined;
let loading: Promise<void> | undefined;

/** Optional eager preparation; ordinary parsing loads only when needed. */
export function prepareHtmlParser(options?: HtmlParserOptions): void | Promise<void> {
  if (options?.htmlParser === 'grovedom') {
    initializeGrove(groveParser(options));
    return;
  }
  if (parser) return;
  return loading ??= import('cheerio').then(module => { parser = module.load; });
}

export function load(
  content: Parameters<typeof cheerioLoad>[0],
  options?: Parameters<typeof cheerioLoad>[1],
  isDocument?: boolean,
  parserOptions?: HtmlParserOptions
): CheerioStatic {
  if (parserOptions?.htmlParser === 'grovedom') {
    const backend = groveParser(parserOptions);
    initializeGrove(backend);
    return backend.load!(content, options, isDocument);
  }
  parser ??= (require('cheerio') as {load: typeof cheerioLoad}).load;
  return parser(content, options, isDocument);
}
