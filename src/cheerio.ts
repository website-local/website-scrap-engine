import {createRequire} from 'node:module';
import type {load as cheerioLoad} from 'cheerio';
import type {CheerioStatic} from './types.js';

export interface HtmlParserOptions {
  /** Synchronous Cheerio-compatible loader, initialized by the application. Defaults to Cheerio. */
  loadHtml?: typeof cheerioLoad;
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
  if (options?.loadHtml) return;
  if (parser) return;
  return loading ??= import('cheerio').then(module => { parser = module.load; });
}

export function load(
  content: Parameters<typeof cheerioLoad>[0],
  options?: Parameters<typeof cheerioLoad>[1],
  isDocument?: boolean,
  parserOptions?: HtmlParserOptions
): CheerioStatic {
  const customLoad = parserOptions?.loadHtml;
  if (customLoad) return customLoad(content, options, isDocument);
  parser ??= (require('cheerio') as {load: typeof cheerioLoad}).load;
  return parser(content, options, isDocument);
}
