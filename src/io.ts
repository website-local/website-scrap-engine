import type {ObjectEncodingOptions} from 'node:fs';
import fs from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import type {ResourceBody, ResourceEncoding} from './resource.js';
import {error as errorLogger} from './logger/logger.js';

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
  const dir: string = dirname(filePath);
  if (!fs.existsSync(dir)) {
    await mkdirRetry(dir);
  }
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
  if (options) {
    await fs.promises.writeFile(filePath, fileData, options);
  } else {
    await fs.promises.writeFile(filePath, fileData);
  }
  // void and NaN check
  if (mtime) {
    if (!atime) {
      atime = mtime;
    }
    try {
      await fs.promises.utimes(filePath, atime, mtime);
    } catch (e) {
      errorLogger.warn('skipping utimes ' + filePath, e);
    }
  }
};
