import {test, expect} from '@jest/globals';
import {parseCssUrlMatches} from '../../src/life-cycle/parse-css-urls.js';
import {parseRefreshLink} from '../../src/life-cycle/process-html-meta.js';

// Small bounded legacy oracles retain extraction semantics, including malformed
// input. Never feed the adversarial long fixtures below to these regexes.
const legacyCss = /(?:@import\s+)?url\s*\(\s*(?:"(.*?)"|'(.*?)'|(.*?))\s*\)|(?:@import\s+)(?:"(.*?)"|'(.*?)'|(.*?))[\s;]/ig;
const legacyRefresh = /^\s*(\d+)(?:\s*;(?:\s*url\s*=)?\s*(?:["']\s*(.*?)\s*['"]|(.*?)))?\s*$/i;

test('bounded seeded CSS and refresh cases retain legacy extraction and offsets', () => {
  let seed = 0x12345678;
  const next = (limit: number): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const atoms = ['url(', '@import ', 'url', '(', ')', '"', '\'', ' ', '\n', '\t', 'a', 'b.css', ';'];
  for (let sample = 0; sample < 3000; sample++) {
    const input = Array.from({length: 1 + next(12)}, () => atoms[next(atoms.length)]).join('');
    const expected = [...input.matchAll(legacyCss)].flatMap(match => {
      const index = match.findIndex((value, index) => index > 0 && !!value);
      if (index < 0) return [];
      const url = match[index];
      const start = match.index + (index === 1 || index === 4 ? match[0].indexOf('"') + 1 :
        index === 2 || index === 5 ? match[0].indexOf('\'') + 1 :
          match[0].indexOf(url, index === 3 ? match[0].indexOf('(') + 1 : 7));
      return [{url, start, end: start + url.length}];
    });
    expect({sample, input, matches: parseCssUrlMatches(input)}).toEqual({sample, input, matches: expected});
    const content = '0;' + input;
    const refresh = legacyRefresh.exec(content);
    expect({sample, input, target: parseRefreshLink(content)}).toEqual({sample, input, target: refresh?.[2] || refresh?.[3] || undefined});
  }
});

test('unfinished CSS delimiters and refresh whitespace remain bounded', () => {
  expect(parseCssUrlMatches('url(' + ' '.repeat(32768) + 'x')).toEqual([]);
  expect(parseCssUrlMatches('url('.repeat(8192))).toEqual([]);
  expect(parseCssUrlMatches('/*a'.repeat(8192))).toEqual([]);
  expect(parseRefreshLink('0;' + ' '.repeat(32768) + 'x\n!')).toBeUndefined();
  const prefix = '/*' + 'a'.repeat(32768) + '*/';
  expect(parseCssUrlMatches(prefix + 'url(a)')).toEqual([{url: 'a', start: prefix.length + 4, end: prefix.length + 5}]);
});

test.each([
  ['0; url="  a  "', 'a'], ['0; url="a\' ', 'a'],
  ['0; url="a', '"a'], ['0; url="\na\n"', 'a'],
  ['0; url="a\nb"', undefined], ['0; url=""', undefined],
])('refresh target from %s', (content, expected) => {
  expect(parseRefreshLink(content)).toBe(expected);
});

test.each([255, 256, 257, 1024])('bounded parser fast paths fall back at length %i', length => {
  const target = 'a'.repeat(length);
  const input = 'url("' + target + '")';
  expect(parseCssUrlMatches(input)).toEqual([{url: target, start: 5, end: 5 + length}]);
  expect(parseRefreshLink('0; url="' + target + '"')).toBe(target);
  expect(parseRefreshLink('0; url=' + target)).toBe(target);
});

test('empty refresh targets and unfinished whitespace do not backtrack into the prefix', () => {
  expect(parseRefreshLink('0;url=')).toBeUndefined();
  expect(parseRefreshLink('0;url=url=')).toBe('url=');
  expect(parseRefreshLink('0;' + ' '.repeat(32768) + '"')).toBe('"');
  expect(parseCssUrlMatches('url(' + ' '.repeat(32768) + '"')).toEqual([]);
});
