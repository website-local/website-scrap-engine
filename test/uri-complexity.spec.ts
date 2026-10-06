import {test, expect} from '@jest/globals';
import URI from '../src/uri.js';
import {hasQuery, removeQuery} from '../src/uri-query.js';
import type {QueryValue} from '../src/uri-query.js';

test('scheme scanning skips long failed candidates and preserves callback positions', () => {
  const prefix = 'a-'.repeat(16384) + '! ';
  const calls: string[] = [];
  expect(URI.withinString(prefix + 'https://a/x then https://b/y', (url, start, end, current) => {
    expect(current.slice(start, end)).toBe(url);
    calls.push(url);
    return 'x';
  })).toBe(prefix + 'x then x');
  expect(calls).toEqual(['https://a/x', 'https://b/y']);
  expect(URI.withinString('_abc://x 123abc-https://b', () => 'x')).toBe('_abc://x 123abc-x');
});

test('query multiset fast paths preserve legacy null and duplicate matching', () => {
  let seed = 0x19b50cf8;
  const next = (limit: number): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const values: QueryValue[] = [null, undefined, 'null', 'undefined', 0, '0', 1, '1', true, 'true', 'a'];
  const matches = (actual: QueryValue, expected: QueryValue): boolean =>
    actual === null ? expected === null : String(actual) === String(expected);
  for (let sample = 0; sample < 2000; sample++) {
    const actual = Array.from({length: 9 + next(12)}, () => values[next(values.length)]);
    const wanted = sample % 2 ? [...actual].reverse() : Array.from({length: actual.length}, () => values[next(values.length)]);
    for (const reuse of [false, true]) {
      const remaining = [...actual];
      const expected = wanted.every(item => {
        const index = remaining.findIndex(value => matches(value, item));
        if (index < 0) return false;
        if (!reuse) remaining.splice(index, 1);
        return true;
      });
      expect({sample, reuse, result: hasQuery({x: actual}, 'x', wanted, reuse)}).toEqual({sample, reuse, result: expected});
    }
    const remaining = actual.filter(item => !wanted.some(value => matches(item, value)));
    expect(removeQuery({x: actual}, 'x', wanted)).toEqual(remaining.length ? {x: remaining} : {});
  }
});

test.each([31, 32, 33, 256, 1024])('scheme fast paths retain long schemes of length %i', length => {
  const url = 'a'.repeat(length) + '-https://e/x';
  const seen: string[] = [];
  expect(URI.withinString('before ' + url + ' after', (value, start, end, current) => {
    expect(current.slice(start, end)).toBe(value);
    seen.push(value);
    return 'local';
  })).toBe('before local after');
  expect(seen).toEqual([url]);
});

test('invalid outer schemes do not repeatedly scan URL tails', () => {
  const prefix = '1://'.repeat(8192);
  const seen: string[] = [];
  expect(URI.withinString(prefix + 'https://e/x', url => { seen.push(url); return 'local'; })).toBe(prefix + 'local');
  expect(seen).toEqual(['https://e/x']);
});


test('scheme callbacks remain reentrant and recover after exceptions', () => {
  const calls: string[] = [];
  const replacements = ['', 'https://replacement', '+'];
  const output = URI.withinString('custom://a "1://custom://b" _bad://c a-b://d', (url, start, end, current) => {
    expect(current.slice(start, end)).toBe(url);
    expect(URI.withinString('nested://x', () => 'inner')).toBe('inner');
    calls.push(url);
    return replacements[calls.length - 1];
  });
  expect(calls).toEqual(['custom://a', 'custom://b', 'a-b://d']);
  expect(output).toBe(' "1://https://replacement" _bad://c +');
  expect(() => URI.withinString('https://a', () => { throw new Error('callback'); })).toThrow('callback');
  expect(URI.withinString('https://b', () => 'recovered')).toBe('recovered');
});

test.each([8, 9, 10])('query threshold %i preserves input arrays and asymmetric null matching', length => {
  const actual = Object.freeze([null, 'null', ...Array<string>(length - 2).fill('a')]);
  for (const wanted of [Object.freeze(['null', null]), Object.freeze(['a', 'null', null])]) {
    const query = {x: [...actual]};
    const original = query.x;
    const selectors = [...wanted];
    expect(hasQuery(query, 'x', [...actual].reverse())).toBe(true);
    expect(removeQuery(query, 'x', selectors)).toEqual(wanted.includes('a') ? {} : {x: Array(length - 2).fill('a')});
    expect(original).toEqual(actual);
    expect(selectors).toEqual(wanted);
  }
});
