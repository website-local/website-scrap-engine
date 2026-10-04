import {createHash} from 'node:crypto';
import type {ResourceBody, ResourceEncoding} from './resource.js';

const forbiddenChar = /[:*?"<>|&]|%3A|%2A|%3F|%22|%3C|%3E|%7C|%26/ig;

export const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms | 0));

export const escapePath = (str: string): string =>
  str && str.replace(forbiddenChar, '_');

export const isSiteMap = (url?: string): boolean | '' | void => url &&
  url.includes('/sitemaps/') &&
  (url.endsWith('sitemap.xml') || url.endsWith('sitemap_other.xml'));

export const arrayToMap = (array: (string | number)[], freeze?: boolean):
  Record<string | number, number> => {
  const obj: Record<string | number, number> = {};
  for (const item of array) {
    obj[item] = 1;
  }
  return freeze ? Object.freeze(obj) : obj;
};

export const toString = (body: ResourceBody, encoding: ResourceEncoding): string => {
  let stringValue: string;
  if (Buffer.isBuffer(body)) {
    stringValue = body.toString(encoding || 'utf8');
  } else if (ArrayBuffer.isView(body)) {
    // note: this would not copy the buffer
    stringValue = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      .toString(encoding || 'utf8');
  } else if (body instanceof ArrayBuffer) {
    // note: this would not copy the buffer
    stringValue = Buffer.from(body).toString(encoding || 'utf8');
  } else {
    stringValue = body;
  }
  return stringValue;
};

export const importDefaultFromPath = <T>(path: string): Promise<T> => {
  return import(path).then(mod => {
    return mod.default || mod;
  });
};

export const orderUrlSearch = (search: string): string => {
  const parts: string[] = (search[0] === '?' ? search.slice(1) : search)
    .split('&');
  const searchKeys: string[] = [],
    searchMap: Record<string, string[]> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const separator = part.indexOf('=');
    const searchKey = separator > 0 ? part.slice(0, separator) : part;
    const value = separator === -1 ? '' : part.slice(separator + 1);
    if (searchMap[searchKey]) {
      searchMap[searchKey].push(value);
    } else {
      searchKeys.push(searchKey);
      searchMap[searchKey] = [value];
    }
  }
  searchKeys.sort();
  parts.length = 0;
  for (const key of searchKeys) {
    for (const value of searchMap[key]) parts.push(key + '=' + value);
  }
  return '?' + parts.join('&');
};

export const simpleHashString = (str: string): string =>
  createHash('sha256')
    .update(str)
    .digest('base64url');

export const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Merge values from source to target only if key not exists in target
 * Note that using this function against incompatible type or null | undefined
 * may lead to typescript parser errors.
 */
export const weakAssign = <T, U>(target: T, source: U): T & U => {
  if (!target) return Object.assign({}, source) as T & U;
  if (!source) return target as T & U;
  for (const key in source) {
    if (hasOwnProperty.call(source, key) &&
      !hasOwnProperty.call(target, key)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Reflect.set(target as any, key, source[key]);
    }
  }
  return target as T & U;
};

/**
 * Test if the given url is http url
 * @param url
 */
export const isUrlHttp = (url: string): boolean =>
  url.startsWith('http://') || url.startsWith('https://');

/** Preserve synchronous lifecycle results without adding a microtask per hook. */
export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return !!value && typeof (value as PromiseLike<T>).then === 'function';
}
