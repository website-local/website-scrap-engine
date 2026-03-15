import {describe, expect, test} from '@jest/globals';
// noinspection ES6PreferShortImport
import {redirectHtml} from '../../src/life-cycle/save-html-to-disk.js';

describe('redirectHtml', function () {
  test('basic redirect', () => {
    const html = redirectHtml('en-US/index.html');
    expect(html).toContain('url=en-US/index.html');
    expect(html).toContain("location.replace('en-US/index.html'");
  });

  test('encoding parameter', () => {
    const html = redirectHtml('path', 'utf-8');
    expect(html).toContain('charset="utf-8"');
  });

  test('default encoding', () => {
    const html = redirectHtml('path');
    expect(html).toContain('charset="utf8"');
  });

  test('escapes single quotes in JS string', () => {
    const html = redirectHtml("it's/a'path");
    expect(html).toContain("location.replace('it\\'s/a\\'path'");
    // meta refresh uses unescaped value
    expect(html).toContain("url=it's/a'path");
  });

  test('path with no special chars is unchanged in JS', () => {
    const html = redirectHtml('foo/bar/index.html');
    expect(html).toContain("location.replace('foo/bar/index.html'");
  });
});
