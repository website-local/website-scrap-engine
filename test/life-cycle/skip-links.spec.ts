import {describe, expect, test} from '@jest/globals';
import {
  skipLinks,
  unProcessableUriSchemes
} from '../../src/life-cycle/skip-links.js';

describe('life-cycle/skip-links', function () {
  test('skip-un-processable-uri-schemes', () => {
    for (const scheme of unProcessableUriSchemes) {
      expect(skipLinks(scheme + '://aaa')).toBeFalsy();
      expect(skipLinks(scheme + ':bbb')).toBeFalsy();
    }
  });
  test('keep-http-url', () => {
    const httpUrls = [
      'http://example.com/aaaa?bbb=ccc#ddd',
      'http://example.com/aaaa',
      'https://example.com/aaaa?bbb=ccc#ddd',
      'https://example.com/aaaa?bbb=ccc',
      'https://example.com/aaaa#eee'
    ];
    for (const url of httpUrls) {
      expect(skipLinks(url)).toBe(url);
    }
  });
  test('skip-hash-url', () => {
    const hashUrls = [
      '#ddd',
      '#sss=111',
      '#!/src/process',
      '#######',
      '#/menu/demo',
      '#example'
    ];
    for (const url of hashUrls) {
      expect(skipLinks(url)).toBeFalsy();
    }
  });
  test('keep-relative-url', () => {
    const httpUrls = [
      '/aaaa?bbb=ccc#ddd',
      '/aaaa',
      'aaaa?bbb=ccc#ddd',
      'aaaa?bbb=ccc',
      'aaaa#eee',
      '?bbb=ccc'
    ];
    for (const url of httpUrls) {
      expect(skipLinks(url)).toBe(url);
    }
  });
});
