import {AsyncLocalStorage} from 'node:async_hooks';
import type {Logger} from './logger/types.js';

/** Internal services scoped to one crawl, including asynchronous hook work. */
export interface CrawlContext {
  logger: Logger;
  signal: AbortSignal;
}

const contexts = new AsyncLocalStorage<CrawlContext>();

export function withCrawlContext<T>(context: CrawlContext, run: () => T): T {
  return contexts.run(context, run);
}

export function currentCrawlContext(): CrawlContext | undefined {
  return contexts.getStore();
}

export function throwIfCancelled(): void {
  contexts.getStore()?.signal.throwIfAborted();
}
