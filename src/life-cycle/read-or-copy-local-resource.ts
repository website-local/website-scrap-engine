import * as path from 'node:path';
import type {Stats} from 'node:fs';
import {promises} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {DownloadResource, RequestOptions} from './types.js';
import type {StaticDownloadOptions} from '../options.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {error as errorLogger} from '../logger/logger.js';
import {mkdirRetry, readFile, safeJoin} from '../io.js';

const FILE_PREFIX = 'file://';

export async function readOrCopyLocalResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<DownloadResource | Resource | true | void> {
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
          stats = undefined;
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
    const fileDestPath = safeJoin(res.localRoot ?? options.localRoot, res.savePath);
    await mkdirRetry(path.dirname(fileDestPath));
    await promises.copyFile(fileSrcPath, fileDestPath);
    await readStats();
  } else {
    // Metadata and content are independent; join both before passing the
    // resource to hooks, including when reading the body fails.
    const metadata = readStats();
    try {
      res.body = await readFile(fileSrcPath, {encoding: res.encoding});
    } finally {
      await metadata;
    }
  }
  res.finishTimestamp = Date.now();
  res.downloadTime =
    res.finishTimestamp - res.downloadStartTimestamp;

  if (res.type === ResourceType.StreamingBinary) {
    return true;
  }
  return res as DownloadResource;
}

/** Selected during configuration only when an existing-resource policy is set. */
export async function readOrCopyLocalResourceWithSavePolicy(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor
): Promise<DownloadResource | Resource | true | void> {
  if (res.body !== undefined || res.type !== ResourceType.StreamingBinary ||
      !res.downloadLink.startsWith(FILE_PREFIX)) {
    return readOrCopyLocalResource(res, requestOptions, options);
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
  if (!fileSrcPath) return;

  const fileDestPath = safeJoin(res.localRoot ?? options.localRoot, res.savePath);
  const stats = await promises.stat(fileSrcPath);
  res.meta.headers = {
    'last-modified': stats.mtime.toISOString(),
    'content-length': stats.size.toString()
  };
  const saveAllowed = await pipeline.shouldSaveResource(res, fileDestPath);
  if (saveAllowed) {
    await mkdirRetry(path.dirname(fileDestPath));
    await promises.copyFile(fileSrcPath, fileDestPath);
  }
  res.finishTimestamp = Date.now();
  res.downloadTime = res.finishTimestamp - res.downloadStartTimestamp;
  if (saveAllowed) return true;
}
