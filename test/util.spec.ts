import {
  arrayToMap,
  escapePath,
  importDefaultFromPath,
  isSiteMap,
  sleep,
  toString, weakAssign
} from '../src/util';
import {join} from 'path';

describe('util', function () {
  test('sleep', async done => {
    const tolerance = 2;
    let ts: number;
    const testSleepTimes = [0, 1, 6, 11, 3, 14];
    for (const time of testSleepTimes) {
      ts = Date.now();
      await sleep(time);
      expect(Date.now() - ts + tolerance).toBeGreaterThanOrEqual(time);
    }
    done();
  });

  test('escapePath', () => {
    expect(escapePath(':*?"<>|&'))
      .toBe('________');
    expect(escapePath(encodeURIComponent(':*?"<>|&')))
      .toBe('________');
  });

  test('isSiteMap', () => {
    expect(isSiteMap('aaa/~!@#$%^&/*()_+=-]/[{}\\|":>?<')).toBeFalsy();
    expect(isSiteMap('http://example.com')).toBeFalsy();
    expect(isSiteMap()).toBeFalsy();
    expect(isSiteMap('')).toBeFalsy();
    expect(isSiteMap('null')).toBeFalsy();
    expect(isSiteMap('http://example.com/rss.xml')).toBeFalsy();
    expect(isSiteMap('http://example.com/sitemaps/sitemap.xml')).toBeTruthy();
    expect(isSiteMap('http://example.com/sitemaps/sitemap_other.xml'))
      .toBeTruthy();
  });

  test('arrayToMap', () => {
    expect(arrayToMap([1, '1', '3', '5', 'aaa'])).toStrictEqual({
      '1': 1,
      '3': 1,
      '5': 1,
      'aaa': 1
    });
    expect(Object.isFrozen(arrayToMap([1], true))).toBeTruthy();
    expect(Object.isFrozen(arrayToMap([1]))).toBeFalsy();
    expect(Object.isExtensible(arrayToMap([1], true))).toBeFalsy();
    expect(Object.isExtensible(arrayToMap([1]))).toBeTruthy();
  });

  test('importDefaultFromPath', () => {
    expect(importDefaultFromPath(join(__dirname, 'util-import-commonjs-export')))
      .toBe('111');
    expect(importDefaultFromPath(join(__dirname, 'util-import-typescript-export')))
      .toBe('111');
  });

  test('toString', () => {
    expect(toString('111', null)).toBe('111');
    expect(toString('111', 'ascii')).toBe('111');
    expect(toString('111', 'hex')).toBe('111');
    expect(toString('111', 'base64')).toBe('111');
    expect(toString(Buffer.of(97, 115, 100, 49, 50, 51), null))
      .toBe('asd123');
    expect(toString(Buffer.of(97, 115, 100, 49, 50, 51), 'ascii'))
      .toBe('asd123');
    expect(toString(Buffer.of(0x12, 0x34, 0x56, 0x78), 'hex'))
      .toBe('12345678');
    expect(toString(Buffer.of(97, 115, 100, 49, 50, 51), 'base64'))
      .toBe('YXNkMTIz');
    expect(toString(Buffer.of(97, 115, 100, 49, 50, 51).buffer, 'base64'))
      .toBe('YXNkMTIz');
    expect(toString(new Uint8Array([97, 115, 100, 49, 50, 51]), 'base64'))
      .toBe('YXNkMTIz');
    expect(toString(new Uint32Array([0x12345678, 0x90abcdef]), 'hex'))
      .toBe('78563412efcdab90');
  });

  test('weakAssign', () => {
    const obj = {};
    expect(weakAssign(null, obj) as typeof obj).toStrictEqual(obj);
    expect(weakAssign(obj, null)).toBe(obj);
    expect(weakAssign({a: 0, b: false}, {a: 2, c: '3'})).toStrictEqual({
      a: 0,
      b: false,
      c: '3'
    });
    expect(weakAssign({a: undefined}, {a: 2, c: '3'}) as {
      a : undefined,
      c: string
    }).toStrictEqual({
      a: undefined,
      c: '3'
    });
    expect(weakAssign({a: NaN}, {a: [], c: '3'}) as {
      a: number,
      c: string
    }).toStrictEqual({
      a: NaN,
      c: '3'
    });
    expect(weakAssign({a: null}, {a: [], c: ['3']}) as {
      a: null,
      c: string[]
    }).toStrictEqual({
      a: null,
      c: ['3']
    });
  });
});
