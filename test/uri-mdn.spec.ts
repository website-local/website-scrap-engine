import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'node:fs';
import URI, {type NativeUri} from '../src/uri.js';

const operations = {
  normalize: (uri: NativeUri) => uri.normalize(),
  normalizePath: (uri: NativeUri) => uri.normalizePath(),
  readable: (uri: NativeUri) => uri.readable(),
  'filename-set': (uri: NativeUri) => uri.filename('probe.txt'),
  'directory-set': (uri: NativeUri) => uri.directory('/probe/'),
  'suffix-set': (uri: NativeUri) => uri.suffix('json'),
  'segment-set': (uri: NativeUri) => uri.segment(-1, 'probe'),
  'segmentCoded-set': (uri: NativeUri) => uri.segmentCoded(-1, '漢字 /?#'),
};

const cases = JSON.parse(readFileSync(new URL('./fixtures/mdn-uri/regressions.json', import.meta.url), 'utf8')) as {
  input: string;
  method: keyof typeof operations;
  expected: string;
}[];

describe('MDN artifact and log URI regressions', () => {
  test.each(cases)('$method: $input', ({input, method, expected}) => {
    const uri = URI(input);
    const result = operations[method](uri);
    expect(typeof result === 'string' ? result : result.href()).toBe(expected);
    if (method === 'readable') expect(uri.href()).toBe(URI(input).href());
    else {
      expect(result).toBe(uri);
      expect(uri.clone().build().href()).toBe(expected);
      const repeated = operations[method](uri);
      expect(typeof repeated === 'string' ? repeated : repeated.href()).toBe(expected);
    }
  });

  test('readable keeps query-space configuration and leaves its source unchanged', () => {
    const uri = URI('https://user:secret@example.org/a%2Fb?q=a+b&escaped=x%26y#c+d').escapeQuerySpace(false);
    const original = uri.href();
    expect(uri.readable()).toBe('https://example.org/a%2Fb?q=a+b&escaped=x%26y#c d');
    expect(uri.href()).toBe(original);
    expect(uri.username()).toBe('user');
    expect(uri.password()).toBe('secret');
  });

  test('native parsing differences and opaque mutation limits stay explicit', () => {
    expect(URI('https://example.org/a#').href()).toBe('https://example.org/a#');
    expect(URI('https://example.org/漢字').path()).toBe('/%E6%BC%A2%E5%AD%97');
    expect(URI('mailto:jane@example.com').readable()).toBe('mailto:jane@example.com');
    const data = URI('data:image/svg+xml,<svg>100%</svg>');
    expect(data.normalize().href()).toBe('data:image/svg+xml,<svg>100%</svg>');
    expect(data.segmentCoded()).toEqual(['image/svg+xml,<svg>100%</svg>']);
    expect(() => data.path('other')).toThrow('opaque URL');
    expect(URI('//example.org/path').readable()).toBe('//example.org/path');
  });

  test.each([
    ['a/../b', 'b'], ['a/.', 'a/'], ['a/..', ''], ['../a/../b', '../b'],
    ['/a//b/', '/a/b/'], ['/a/.../b', '/a/.../b'], ['/a/..name', '/a/..name'],
    ['/a!b*()/c', '/a%21b%2A%28%29/c'], ['/a[0]/c', '/a%5B0%5D/c'],
    ['/%24%26%2b%2c%3b%3d%3a%40', '/$&+,;=:@'], ['/%2f%3f%23', '/%2F%3F%23'],
    ['/漢字', '/%E6%BC%A2%E5%AD%97'], ['/bad%ZZ', '/bad%ZZ'],
    ['/a-b._~/$&+,;=:@/c', '/a-b._~/$&+,;=:@/c'],
  ])('path normalization boundaries: %s', (input, expected) => {
    const uri = URI(input);
    uri.href();
    expect(uri.normalizePath().path()).toBe(expected);
    expect(uri.clone().build().href()).toBe(uri.href());
    expect(uri.normalizePath().path()).toBe(expected);
  });

  test('malformed scheme inputs distinguish parsing from resolving raw text', () => {
    const raw = 'https:_www.ctrl.blog/entry/webp-avif-comparison.html';
    const base = 'https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Image_types';
    expect(URI(raw).absoluteTo(base).href()).toBe('https://_www.ctrl.blog/entry/webp-avif-comparison.html');
    expect(URI(raw, base).href()).toBe(new URL(raw, base).href);
    expect(URI(raw, base).hostname()).toBe('developer.mozilla.org');
  });

  test('component setters recode the replacement without changing untouched path parts', () => {
    const input = 'https://example.org/(parent)/file(x).txt';
    expect(URI(input).filename('(new).txt').href()).toBe('https://example.org/(parent)/%28new%29.txt');
    expect(URI(input).directory('/(dir)').href()).toBe('https://example.org/%28dir%29/file(x).txt');
    expect(URI(input).suffix('json').href()).toBe('https://example.org/(parent)/file(x).json');
    expect(URI(input).segment(-1, 'new').href()).toBe('https://example.org/%28parent%29/new');
  });

  test('normalization preserves leading fragment hashes found in archived logs', () => {
    for (const hash of ['##the-future-pseudo', '###part', '##%70art']) {
      const expected = hash.replace('%70', 'p');
      const uri = URI('https://drafts.csswg.org/selectors-4/' + hash);
      expect(uri.normalize().hash()).toBe(expected);
      expect(uri.normalize().hash()).toBe(expected);
      expect(uri.readable()).toBe('https://drafts.csswg.org/selectors-4/' + expected);
    }
    expect(URI('https://example.org/#').normalizeFragment().hash()).toBe('');
  });

  test.each([
    ['//EXAMPLE.org./a', 'example.org.'], ['//localhost/a', 'localhost'],
    ['//a_b.example/a', 'a_b.example'], ['//0x7f.1/a', '127.0.0.1'],
    ['//127.1/a', '127.0.0.1'], ['//2130706433/a', '127.0.0.1'],
    ['//例子.测试/a', 'xn--fsqu00a.xn--0zwm56d'], ['//[::1]/a', '::1'],
  ])('hostname normalization boundaries: %s', (input, expected) => {
    const uri = URI(input);
    expect(uri.normalizeHostname().hostname()).toBe(expected);
    expect(uri.clone().build().hostname()).toBe(expected);
    expect(uri.normalizeHostname().hostname()).toBe(expected);
  });
});
