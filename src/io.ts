import {currentCrawlContext, throwIfCancelled} from './crawl-context.js';
import type {ObjectEncodingOptions} from 'node:fs';
import fs from 'node:fs';
import {join, resolve, sep} from 'node:path';
import type {ResourceBody, ResourceEncoding} from './resource.js';
import {error as errorLogger} from './logger/logger.js';
import {publishFile} from './output-store.js';

export const mkdirRetry = async (dir: string): Promise<void> => {
  await fs.promises.mkdir(dir, {recursive: true});
};

export const safeJoin = (root: string, relativePath: string): string => {
  const filePath = join(root, relativePath);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(filePath);
  // Compare resolved paths so custom save paths cannot traverse outside root.
  if (resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error('Resolved path escapes root: ' + relativePath);
  }
  return filePath;
};

export const writeFile = async (
  filePath: string,
  data: ResourceBody,
  encoding: ResourceEncoding,
  mtime?: number | void,
  atime?: number | void
): Promise<void> => {
  throwIfCancelled();
  let fileData: Uint8Array | string;
  let options: ObjectEncodingOptions | void = void 0;
  if (typeof data === 'string') {
    fileData = data;
    options = {encoding};
  } else if (data instanceof ArrayBuffer) {
    fileData = Buffer.from(data);
  } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    fileData = data;
  } else if (ArrayBuffer.isView(data)) {
    fileData = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else {
    // not likely happen
    throw new TypeError('Type of data not supported.');
  }
  await publishFile(filePath, async stagingPath => {
    if (options) {
      await fs.promises.writeFile(stagingPath, fileData, options);
    } else {
      await fs.promises.writeFile(stagingPath, fileData);
    }
    if (typeof mtime === 'number' && Number.isFinite(mtime)) {
      try {
        await fs.promises.utimes(stagingPath, atime ?? mtime, mtime);
      } catch (e) {
        errorLogger.warn('skipping utimes ' + filePath, e);
      }
    }
  }, currentCrawlContext()?.signal);
};
