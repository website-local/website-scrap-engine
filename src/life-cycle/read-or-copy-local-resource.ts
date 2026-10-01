import type {Stats} from 'node:fs';
import {promises} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {DownloadResource, RequestOptions} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import {error as errorLogger} from '../logger/logger.js';
import {copyResourceToDisk} from './copy-resource-to-disk.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {readResourceFile} from '../resource-limits.js';

const FILE_PREFIX = 'file://';

export async function readOrCopyLocalResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions,
  pipeline?: PipelineExecutor
): Promise<DownloadResource | Resource | void> {
  if (res.body !== undefined) {
    return res as DownloadResource;
  }
  if (!res.downloadLink.startsWith(FILE_PREFIX)) {
    return res;
  }
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
  let fileSrcPath: string;
  try {
    fileSrcPath = fileURLToPath(res.downloadLink);
  } catch {
    fileSrcPath = res.downloadLink.slice(FILE_PREFIX.length);
  }
  if (!fileSrcPath) {
    return;
  }
  // index.html handling
  let stats: Stats | void = void 0;
  if (res.type === ResourceType.Html) {
    stats = await promises.stat(fileSrcPath);
    if (stats.isDirectory()) {
      for (const index of ['index.html', 'index.htm']) {
        if (await promises.access(fileSrcPath + '/' + index)
          .then(() => true).catch(() => false)) {
          fileSrcPath += '/' + index;
          break;
        }
      }
    }
  }
  const readStats = async () => {
    try {
      stats ??= await promises.stat(fileSrcPath);
      res.meta.headers = {
        'last-modified': stats.mtime.toISOString(),
        'content-length': stats.size.toString()
      };
    } catch (e) {
      errorLogger.warn('stat ' + fileSrcPath, e);
    }
  };
  if (res.type === ResourceType.StreamingBinary) {
    await readStats();
    await copyResourceToDisk(fileSrcPath, res, options, pipeline);
  } else {
    // Reading bytes does not depend on file metadata. Await both operations so
    // headers are complete before hooks run, without serial filesystem latency.
    const metadata = readStats();
    try {
      res.body = await readResourceFile(fileSrcPath, res.encoding, options.maxResourceBytes, pipeline?.signal);
    } finally {
      await metadata;
    }
  }
  res.finishTimestamp = Date.now();
  res.downloadTime =
    res.finishTimestamp - res.downloadStartTimestamp;

  if (res.type === ResourceType.StreamingBinary) {
    return;
  }
  return res as DownloadResource;
}
