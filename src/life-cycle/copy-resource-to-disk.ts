import {createReadStream, createWriteStream, promises as fs} from 'node:fs';
import {pipeline as pipe} from 'node:stream/promises';
import {checkResourceSize, limitResourceStream} from '../resource-limits.js';
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
  const signal = pipeline?.signal ?? currentCrawlContext()?.signal;
  if (options.maxResourceBytes !== undefined) {
    checkResourceSize((await fs.stat(source)).size, options.maxResourceBytes);
  }
  return publishFile(destination, async staging => {
    if (options.maxResourceBytes === undefined) await fs.copyFile(source, staging);
    else await pipe(createReadStream(source), limitResourceStream(options.maxResourceBytes),
      createWriteStream(staging), {signal});
  }, signal, root,
  pipeline ? () => pipeline.shouldSaveResource(res) : undefined);
}
