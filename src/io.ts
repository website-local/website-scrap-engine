import {ResourceBody, ResourceEncoding} from './resource';
import {dirname} from 'path';
import fs from 'fs';
import mkdirP from 'mkdirp';
import * as logger from './logger/logger';

export const mkdirRetrySync = (dir: string): string | void => {
  try {
    if (!fs.existsSync(dir)) {
      return mkdirP.sync(dir);
    }
  } catch (e) {
    logger.mkdir.trace('mkdir ', dir, 'fail', e);
    // in case of concurrent dir creation
    try {
      if (!fs.existsSync(dir)) {
        return mkdirP.sync(dir);
      }
    } catch (e) {
      logger.mkdir.debug('mkdir ', dir, 'fail again', e);
      // try again, 3 times seeming pretty enough
      if (!fs.existsSync(dir)) {
        return mkdirP.sync(dir);
      }
    }
  }
};
export const mkdirRetry = async (dir: string): Promise<string | void> => {
  try {
    if (!fs.existsSync(dir)) {
      return await mkdirP(dir);
    }
  } catch (e) {
    logger.mkdir.trace('mkdir ', dir, 'fail', e);
    // in case of concurrent dir creation
    try {
      if (!fs.existsSync(dir)) {
        return await mkdirP(dir);
      }
    } catch (e) {
      logger.mkdir.debug('mkdir ', dir, 'fail again', e);
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
  } else {
    return fs.promises.writeFile(filePath, data);
  }
};
