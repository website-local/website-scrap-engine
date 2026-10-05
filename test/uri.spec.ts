import {describe, expect, test} from '@jest/globals';
import URI, {NativeUri} from '../src/uri.js';

describe('native URL compatibility adapter', () => {
  test('supports callable/new construction and independent mutable clones', () => {
    const uri = URI('https://example.org/a?x=1#part');
    expect(uri).toBeInstanceOf(URI);
    expect(new URI(uri)).toBeInstanceOf(NativeUri);
    expect(uri.clone().hostname('other.org').path('/b').hash('next').toString())
      .toBe('https://other.org/b?x=1#next');
    expect(uri.toString()).toBe('https://example.org/a?x=1#part');
    expect(JSON.stringify(uri)).toBe('"https://example.org/a?x=1#part"');
  });

  test('uses native host, port, Unicode and encoded-dot normalization', () => {
    for (const value of ['https://EXAMPLE.org:443/a',
      'https://例子.测试/路径', 'https://example.org/a/%2e%2e/b',
      'https://example.org/a?#', 'https://user:pass@[::1]:8080/a']) {
      expect(URI(value).toString()).toBe(new URL(value).href);
    }
    expect(URI('https://[::1]:8080/a').hostname()).toBe('::1');
    expect(() => URI('https://bad host/a')).toThrow('Invalid URL');
  });

  test('relative references never expose an artificial origin', () => {
    for (const value of ['', '../a', './a', '/a', '?x=1', '#part',
      '../a b?x=a%20b#part']) {
      const uri = URI(value);
      expect(uri.toString()).toBe(value);
      expect(uri.host()).toBe('');
      expect(uri.protocol()).toBe('');
      expect(uri.absoluteTo('https://example.org/docs/page').toString())
        .toBe(new URL(value, 'https://example.org/docs/page').href);
      expect(uri.toString()).toBe(value);
    }
    const network = URI('//example.org:80/a');
    expect(network.toString()).toBe('//example.org:80/a');
    expect(network.protocol()).toBe('');
    expect(network.absoluteTo('https://other.org').toString())
      .toBe('https://example.org:80/a');
    expect(URI('//example.org').host('other.org').path('/a').toString())
      .toBe('//other.org/a');
  });

  test('relative output references resolve back to their targets', () => {
    const targets = ['file:///site/a.html', 'file:///site/a/',
      'file:///site/a/b.html', 'file:///site/x%20y.html',
      'file:///site/a:b.html', 'file:///site/a.html?x=1#part',
      'file:///site/a.html?', 'file:///site/a.html#',
      'file:///site/a.html?#', 'file:///site/a//b.html'];
    const bases = ['file:///site/a.html', 'file:///site/a/',
      'file:///site/a/b.html', 'file:///site/a.html?other=1'];
    for (const target of targets) {
      for (const base of bases) {
        const relative = URI(target).relativeTo(base);
        expect(relative.protocol()).toBe(target.includes('/a//') ? 'file' : '');
        expect(new URL(relative.toString(), base).href).toBe(target);
      }
    }
    expect(URI('file:///site/a/').relativeTo('file:///site/a/b').toString())
      .toBe('./');
    expect(URI('file:///site/a:b.html').relativeTo('file:///site/c').toString())
      .toBe('./a:b.html');
    expect(URI('https://other.org/a').relativeTo('https://example.org/b').toString())
      .toBe('https://other.org/a');
    const drive = URI('file:///D:/b').relativeTo('file:///C:/a');
    expect(new URL(drive.toString(), 'file:///C:/a').href).toBe('file:///D:/b');
  });

  test('query reads and path/fragment mutations preserve raw query spelling', () => {
    const uri = URI('https://example.org/a?x=a%20b&y=~&x=2#part');
    expect(uri.query()).toBe('x=a%20b&y=~&x=2');
    expect(uri.query(true)).toEqual({x: ['a b', '2'], y: '~'});
    uri.path('/b').hash('next');
    expect(uri.search()).toBe('?x=a%20b&y=~&x=2');
    expect(uri.toString()).toBe('https://example.org/b?x=a%20b&y=~&x=2#next');
    uri.query({x: ['a b', '2'], empty: null, absent: undefined});
    expect(uri.search()).toBe('?x=a+b&x=2&empty');
    expect(URI('?__proto__=x&constructor=y').query(true))
      .toEqual({constructor: 'y'});
  });

  test('supports the MDN filename and redirect mutation patterns', () => {
    const uri = URI('https://example.org/data/Name.json?x=1');
    expect(uri.filename()).toBe('Name.json');
    expect(uri.clone().filename('hash.json').toString())
      .toBe('https://example.org/data/hash.json?x=1');
    expect(uri.host('other.org:8080').protocol('http').search('').path('/a/../b')
      .normalizePath().toString()).toBe('http://other.org:8080/b');
    expect(URI('../a/../b').normalizePath().toString()).toBe('../b');
  });

  test('rejects invalid authorities and unsupported opaque mutations', () => {
    const uri = URI('https://example.org/a');
    expect(() => uri.host('other.org/path')).toThrow('Invalid authority');
    expect(uri.toString()).toBe('https://example.org/a');
    expect(() => URI('mailto:user@example.org').path('/a')).toThrow('opaque URL');
  });

  test('directory operations distinguish authority roots and relative filenames', () => {
    expect(URI('https://example.org/file').directory()).toBe('/');
    expect(URI('filename').directory()).toBe('');
    expect(URI('dir/file').directory('new').toString()).toBe('new/file');
    expect(URI('dir/file').directory('').toString()).toBe('file');
    expect(URI('mailto:user@example.org').filename()).toBe('');
    expect(URI('mailto:user@example.org').is('urn')).toBe(true);
    expect(URI('../file').is('url')).toBe(true);
  });
});
