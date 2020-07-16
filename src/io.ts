import {ResourceBody, ResourceEncoding} from './resource';
import {dirname} from 'path';
import fs from 'fs';
import mkdirP from 'mkdirp';
import {mkdir as mkdirLogger} from './logger/logger';

export const mkdirRetry = async (dir: string, retry = 3): Promise<string | void> => {
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
  if (typeof data === 'string') {
    return fs.promises.writeFile(filePath, data, {encoding});
  } else if (data instanceof ArrayBuffer) {
    return fs.promises.writeFile(filePath, Buffer.from(data));
  } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    return fs.promises.writeFile(filePath, data);
  } else if (ArrayBuffer.isView(data)) {
    return fs.promises.writeFile(filePath, Buffer.from(data.buffer));
  } else {
    // not likely happen
    throw new TypeError('Type of data not supported.');
  }
};
