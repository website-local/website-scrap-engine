import {describe, expect, test} from '@jest/globals';
import URI, {type UriParts} from '../src/uri.js';

describe('URIjs public helper compatibility', () => {
  test('resolution preserves query policy without sharing mutable results', () => {
    const base = 'https://example.org/a?old=1';
    const source = URI('../b').duplicateQueryParameters(true).escapeQuerySpace(false);
    const absolute = source.absoluteTo(base);
    const targets = [absolute, URI(base + '#h'), URI('https://example.org/a?new=1'),
      URI('https://other.org/b')];
    for (const target of targets) {
      target.duplicateQueryParameters(true).escapeQuerySpace(false);
      const relative = target.relativeTo(base);
      expect(relative.query({x: ['a b', 'a b']}).query()).toBe('x=a%20b&x=a%20b');
      expect(target.query()).not.toBe(relative.query());
    }
    expect(absolute.query({x: ['a b', 'a b']}).query()).toBe('x=a%20b&x=a%20b');
    expect(source.href()).toBe('../b');
  });

  test('path and URN segment codecs preserve their different delimiters', () => {
    expect(URI.encodePathSegment('a/b:c?d#e![]')).toBe('a%2Fb:c%3Fd%23e%21%5B%5D');
    expect(URI.encodeUrnPathSegment('a/b:c?d#e![]')).toBe('a%2Fb%3Ac%3Fd%23e!%5B%5D');
    expect(URI.decodePathSegment('a%2Fb%3Ac%3Fd%23e')).toBe('a%2Fb:c%3Fd%23e');
    expect(URI.decodeUrnPathSegment('a%2Fb%3Ac%3Fd%23e')).toBe('a%2Fb%3Ac%3Fd%23e');
    expect(URI.decodePath('/a%20b/c%2Fd')).toBe('/a b/c%2Fd');
    expect(URI.decodeUrnPath('a%20b:c%3Ad')).toBe('a b:c%3Ad');
    expect(URI.recodePath('/a%20b/c%2fd')).toBe('/a%20b/c%2Fd');
    expect(URI.recodeUrnPath('a%20b:c%3ad')).toBe('a%20b:c%3Ad');
  });

  test('public codecs retain malformed-input behavior without weakening normalization', () => {
    for (const name of ['decodePathSegment', 'decodeUrnPathSegment', 'decodePath', 'decodeUrnPath'] as const) {
      expect(URI[name]('%ZZ?')).toBe('%ZZ?');
    }
    for (const name of ['encodePathSegment', 'encodeUrnPathSegment', 'encodeReserved'] as const) {
      expect(URI[name]('\ud800')).toBe('\ud800');
    }
    expect(() => URI.recodePath('/%ZZ')).toThrow(URIError);
    expect(() => URI.recodeUrnPath('a:%FF')).toThrow(URIError);
    expect(URI('/%ZZ').normalizePath().href()).toBe('/%ZZ');
    expect(URI.encodeReserved('https://[::1]/a b?x=[]')).toBe('https://[::1]/a%20b?x=[]');
  });

  test('parts credentials cannot introduce host, path, query or fragment delimiters', () => {
    const parts = {protocol: 'https', hostname: 'example.org', path: '/asset',
      username: 'name@other/?#%', password: 'p:ss /%'};
    const expected = 'https://name%40other%2F%3F%23%25:p%3Ass%20%2F%25@example.org/asset';
    expect(URI.build(parts)).toBe(expected);
    expect(URI(parts).href()).toBe(expected);
    expect(URI(parts).hostname()).toBe('example.org');
    const parsed = URI.parse(expected);
    expect(parsed.username).toBe(parts.username);
    expect(parsed.password).toBe(parts.password);
    expect(URI.build(parsed)).toBe(expected);
    expect(URI.buildHost({port: '8080'})).toBe('');
    for (const protocol of ['https', 'https:']) {
      for (const query of [undefined, null, '', {}]) {
        expect(URI.build({...parts, protocol, query})).toBe(expected);
      }
      expect(URI.build({...parts, protocol, query: {q: 'a b'}})).toBe(expected + '?q=a+b');
      expect(URI.build({...parts, protocol, query: 'q=a%20b'})).toBe(expected + '?q=a%20b');
    }
  });

  test('userinfo parsing decodes credentials and recognizes path boundaries', () => {
    const parts: UriParts = {};
    expect(URI.parseUserinfo('u%20s:p%3Ass@example.org/a', parts)).toBe('example.org/a');
    expect(parts).toEqual({username: 'u s', password: 'p:ss'});
    expect(URI.parseUserinfo('example.org\\path@other/a', parts)).toBe('example.org/path@other/a');
    expect(parts).toEqual({username: null, password: null});
    expect(() => URI.parseUserinfo('%ZZ:p@example.org/', {})).toThrow(URIError);
  });

  test('query parameter building handles flags, undefined and explicit space policy', () => {
    expect(URI.buildQueryParameter('a b', null)).toBe('a+b');
    expect(URI.buildQueryParameter('a b', undefined, false)).toBe('a%20b=undefined');
    expect(URI.buildQueryParameter('a', 'x+y z')).toBe('a=x%2By+z');
  });

  test('empty path joins remain empty', () => {
    expect(URI.joinPaths().href()).toBe('');
    expect(URI.joinPaths('', '/', '/').href()).toBe('');
    expect(URI.joinPaths('/', 'a', 'b').href()).toBe('/a/b');
  });

  test('withinString supports observers and reports offsets in the updated source', () => {
    const source = 'See https://a.example/a then https://b.example/b done';
    const seen: string[] = [];
    expect(URI.withinString(source, url => { seen.push(url); })).toBe(source);
    expect(seen).toEqual(['https://a.example/a', 'https://b.example/b']);
    const calls: [number, string][] = [];
    expect(URI.withinString(source, (url, start, end, current) => {
      expect(current.slice(start, end)).toBe(url);
      calls.push([start, current]);
      return 'x';
    })).toBe('See x then x done');
    expect(calls[1]).toEqual([11, 'See x then https://b.example/b done']);
  });
});
