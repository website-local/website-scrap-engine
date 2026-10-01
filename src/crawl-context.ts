import type {OutputDirectories, PublicationStore, StagingDirectories} from './output-store.js';
import type {PublicationReservations} from './publication-reservations.js';
import type {BufferAccount} from './buffer-budget.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Logger} from './logger/types.js';

export interface ResourceProgress {
  downloaded: boolean;
  publishedFiles: number;
  skipped: boolean;
}

export const createResourceProgress = (): ResourceProgress =>
  ({downloaded: false, publishedFiles: 0, skipped: false});

/** Internal services scoped to one crawl, including asynchronous hook work. */
export interface CrawlContext {
  logger: Logger;
  signal: AbortSignal;
  resourceProgress?: ResourceProgress;
  publicationStore?: PublicationStore;
  stagingDirectories?: StagingDirectories;
  outputDirectories?: OutputDirectories;
  directWrites?: boolean;
  publicationReservations?: PublicationReservations;
  publicationOwner?: string;
  bufferAccount?: BufferAccount;
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

export function markResourceDownloaded(): void {
  const progress = contexts.getStore()?.resourceProgress;
  if (progress) progress.downloaded = true;
}

export function markResourceSkipped(): void {
  const progress = contexts.getStore()?.resourceProgress;
  if (progress) progress.skipped = true;
}

export function recordResourcePublication(): void {
  const progress = contexts.getStore()?.resourceProgress;
  if (progress) ++progress.publishedFiles;
}
