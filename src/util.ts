import fs from 'fs';
import mkdirP from 'mkdirp';
import * as logger from './logger';

const forbiddenChar = /([:*?"<>|]|%3A|%2A|%3F|%22|%3C|%3E|%7C)+/ig;

export const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms | 0));

export const escapePath = (str: string) : string =>
  str && str.replace(forbiddenChar, '_');

export const isSiteMap = (url?: string) : boolean | '' | void => url &&
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

