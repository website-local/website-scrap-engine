import {Resource, ResourceType} from '../resource';
import {DownloadResource, RequestOptions} from './types';
import {StaticDownloadOptions} from '../options';
import {promises} from 'fs';
import * as path from 'path';

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
  const fileSrcPath = res.downloadLink.slice(FILE_PREFIX.length);
  if (!fileSrcPath) {
    return;
  }
  if (res.type ===  ResourceType.StreamingBinary) {
    const fileDestPath = path.join(res.localRoot ?? options.localRoot, res.savePath);
    await promises.copyFile(fileSrcPath, fileDestPath);
  } else {
    res.body = await promises.readFile(fileSrcPath, {
      encoding: res.encoding
    });
  }
  res.finishTimestamp = Date.now();
  res.downloadTime =
    res.finishTimestamp - res.downloadStartTimestamp;

  if (res.type ===  ResourceType.StreamingBinary) {
    return;
  }
  return res as DownloadResource;
}
