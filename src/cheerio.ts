import {createRequire} from 'node:module';
import type {load as cheerioLoad} from 'cheerio';

// Binary-only workers do not need an HTML parser. Keep the synchronous parser
// API while deferring its dependency graph until the first document is parsed.
const require = createRequire(import.meta.url);
let parser: typeof cheerioLoad | undefined;
let loading: Promise<void> | undefined;

/** Load the ESM parser once before asynchronous markup lifecycle hooks. */
export function prepareHtmlParser(): void | Promise<void> {
  if (parser) return;
  return loading ??= import('cheerio').then(module => { parser = module.load; });
}

export const load: typeof cheerioLoad = (...args) => {
  parser ??= (require('cheerio') as {load: typeof cheerioLoad}).load;
  return parser(...args);
};
