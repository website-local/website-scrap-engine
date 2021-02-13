import fs from 'fs';
import type {BaseEncodingOptions} from 'fs';
import {dirname} from 'path';
import mkdirP from 'mkdirp';
import type {ResourceBody, ResourceEncoding} from './resource';
import {mkdir as mkdirLogger} from './logger/logger';

export const mkdirRetry = async (dir: string, retry = 3): Promise<void> => {
  let error: Error | void;
  for (let i = 0; i < retry; i++) {
    error = undefined;
    try {
      await mkdirP(dir);
    } catch (e) {
      error = e;
      if (i > 0) {
        mkdirLogger.debug('mkdir', dir, 'fail', i, 'times', e);
      } else {
        mkdirLogger.trace('mkdir', dir, 'fail', i, 'times', e);
      }
      continue;
    }
    error = undefined;
    return;
  }
  if (error) {
    throw error;
  }
};

export const writeFile = async (
  filePath: string,
  data: ResourceBody,
  encoding: ResourceEncoding
): Promise<void> => {
  const dir: string = dirname(filePath);
  if (!fs.existsSync(dir)) {
    await mkdirRetry(dir);
  }
  let fileData: Uint8Array | string;
  let options: BaseEncodingOptions | void;
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
    return fs.promises.writeFile(filePath, fileData, options);
  } else {
    return fs.promises.writeFile(filePath, fileData);
  }
};
