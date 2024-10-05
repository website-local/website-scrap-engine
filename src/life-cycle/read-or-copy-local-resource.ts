import * as path from 'path';
import {promises, Stats} from 'fs';
import {Resource, ResourceType} from '../resource';
import type {DownloadResource, RequestOptions} from './types';
import type {StaticDownloadOptions} from '../options';
import {error as errorLogger} from '../logger/logger';

const FILE_PREFIX = 'file://';

export async function readOrCopyLocalResource(
  res: Resource,
  requestOptions: RequestOptions,
  options: StaticDownloadOptions
): Promise<DownloadResource | Resource | void> {
  if (res.body) {
    return res as DownloadResource;
  }
  if (!res.downloadLink.startsWith(FILE_PREFIX)) {
    return res;
  }
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
  let fileSrcPath = res.downloadLink.slice(FILE_PREFIX.length);
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
  if (res.type ===  ResourceType.StreamingBinary) {
    const fileDestPath = path.join(res.localRoot ?? options.localRoot, res.savePath);
    await promises.copyFile(fileSrcPath, fileDestPath);
  } else {
    res.body = await promises.readFile(fileSrcPath, {
      encoding: res.encoding
    });
  }
  try {
    if (!stats) {
      stats = await promises.stat(fileSrcPath);
    }
    if (stats) {
      res.meta.headers = {
        'last-modified': stats.mtime.toISOString(),
        'content-length': stats.size.toString()
      };
    }
  } catch (e) {
    errorLogger.warn('stat ' + fileSrcPath, e);
  }
  res.finishTimestamp = Date.now();
  res.downloadTime =
    res.finishTimestamp - res.downloadStartTimestamp;

  if (res.type ===  ResourceType.StreamingBinary) {
    return;
  }
  return res as DownloadResource;
}
