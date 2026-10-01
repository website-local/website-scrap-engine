import {promises as fs} from 'node:fs';
import {currentCrawlContext} from '../crawl-context.js';
import {safeJoin} from '../io.js';
import {publishFile} from '../output-store.js';
import type {Resource} from '../resource.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';

/** Copy without exposing partial output or bypassing the save-stage policy. */
export async function copyResourceToDisk(
  source: string, res: Resource, options: StaticDownloadOptions, pipeline?: PipelineExecutor
): Promise<boolean> {
  const root = res.localRoot ?? options.localRoot;
  const destination = safeJoin(root, decodeURI(res.savePath));
  return publishFile(destination, async staging => {
    await fs.copyFile(source, staging);
  }, pipeline?.signal ?? currentCrawlContext()?.signal, root,
  pipeline ? () => pipeline.shouldSaveResource(res) : undefined);
}
