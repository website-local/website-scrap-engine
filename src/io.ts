import {ResourceBody, ResourceEncoding} from './resource';
import {dirname} from 'path';
import fs from 'fs';
import mkdirP from 'mkdirp';
import {mkdir as mkdirLogger} from './logger/logger';

export const mkdirRetry = async (dir: string): Promise<string | void> => {
  try {
    if (!fs.existsSync(dir)) {
      return await mkdirP(dir);
    }
  } catch (e) {
    mkdirLogger.trace('mkdir', dir, 'fail', e);
    // in case of concurrent dir creation
    try {
      if (!fs.existsSync(dir)) {
        return await mkdirP(dir);
      }
    } catch (e) {
      mkdirLogger.debug('mkdir', dir, 'fail again', e);
      // try again, 3 times seeming pretty enough
      if (!fs.existsSync(dir)) {
        return await mkdirP(dir);
      }
    }
  }
};

export const writeFile = async (
  filePath: string,
  data: ResourceBody,
  encoding: ResourceEncoding): Promise<void> => {
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
