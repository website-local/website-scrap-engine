import fs from 'fs';
import mkdirP from 'mkdirp';
import * as logger from './logger/logger';
import {ResourceBody, ResourceEncoding} from './resource';
import {dirname} from 'path';
import {createHash} from 'crypto';

const forbiddenChar = /([:*?"<>|&]|%3A|%2A|%3F|%22|%3C|%3E|%7C|%26)+/ig;

export const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms | 0));

export const escapePath = (str: string): string =>
  str && str.replace(forbiddenChar, '_');

export const isSiteMap = (url?: string): boolean | '' | void => url &&
  url.includes('/sitemaps/') &&
  (url.endsWith('sitemap.xml') || url.endsWith('sitemap_other.xml'));

export const arrayToMap = (array: (string | number)[]):
  Record<string | number, number> => {
  const obj: Record<string | number, number> = {};
  for (const item of array) {
    obj[item] = 1;
  }
  return obj;
};

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

export const toString = (body: ResourceBody, encoding: ResourceEncoding): string => {
  let stringValue: string;
  if (Buffer.isBuffer(body)) {
    stringValue = body.toString(encoding || 'utf8');
  } else if (ArrayBuffer.isView(body)) {
    // note: this would not copy the buffer
    stringValue = Buffer.from(body.buffer).toString(encoding || 'utf8');
  } else if (body instanceof ArrayBuffer) {
    // note: this would not copy the buffer
    stringValue = Buffer.from(body).toString(encoding || 'utf8');
  } else {
    stringValue = body;
  }
  return stringValue;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const importDefaultFromPath = (path: string): any => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-explicit-any
  const mod: any = require(path);
  if (mod && mod.__esModule && mod.default) {
    return mod.default;
  }
  return mod;
};

export const orderUrlSearch = (search: string): string => {
  const parts: string[] = (search[0] === '?' ? search.slice(1) : search)
    .split('&');
  const searchKeys: string[] = [],
    searchMap: Record<string, string[]> = {};
  let searchParam: string[] , searchKey: string;
  for (let i = 0; i < parts.length; i++) {
    searchParam= parts[i].split('=');
    if (searchMap[searchKey = searchParam.shift() || parts[i]]) {
      searchMap[searchKey].push(searchParam.join('='));
    } else {
      searchKeys.push(searchKey);
      searchMap[searchKey] = [searchParam.join('=')];
    }
  }
  return '?' + searchKeys
    .sort()
    .map(k => searchMap[k]?.map(v => k + '=' + v).join('&'))
    .join('&');
};

export const simpleHashString = (str: string): string =>
  createHash('sha256')
    .update(str)
    .digest()
    .toString('base64')
    // making it url-safe
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
