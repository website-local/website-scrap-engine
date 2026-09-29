import {describe, expect, test} from '@jest/globals';
import parseCssUrls from '../../src/life-cycle/parse-css-urls.js';
import {parseCssUrlMatches} from '../../src/life-cycle/parse-css-urls.js';

describe('parseCssUrls', () => {
  test('parses css urls and imports', () => {
    const cssText = `
      /* url("/commented.png") */
      @import "reset.css";
      @import url('theme.css');
      .hero { background: url("/image.png"); }
      .icon { background: url(data:image/png;base64,aaaa); }
      .again { background: url("/image.png"); }
    `;

    expect(parseCssUrls(cssText)).toEqual([
      'reset.css',
      'theme.css',
      '/image.png'
    ]);
  });

  test('resets regex state between calls', () => {
    expect(parseCssUrls('a { background: url("a.png"); }')).toEqual(['a.png']);
    expect(parseCssUrls('b { background: url("b.png"); }')).toEqual(['b.png']);
  });

  test('returns offsets from the original css text', () => {
    const cssText = '/* url("skip.png") */ .a { background: url("a.png"); }';

    expect(parseCssUrlMatches(cssText)).toEqual([
      {
        url: 'a.png',
        start: cssText.indexOf('a.png'),
        end: cssText.indexOf('a.png') + 'a.png'.length,
      }
    ]);
  });

  test('keeps every repeated match and deduplicates in first-seen order', () => {
    const cssText = '@import "b.css"; /* url(ignored.png) */ ' +
      '.a { x: url("a.png"); y: url(a.png); z: url("b.css"); }';
    const urls = ['b.css', 'a.png', 'a.png', 'b.css'];
    const starts = [
      cssText.indexOf('b.css'),
      cssText.indexOf('a.png'),
      cssText.lastIndexOf('a.png'),
      cssText.lastIndexOf('b.css')
    ];

    expect(parseCssUrlMatches(cssText)).toEqual(urls.map((url, index) => ({
      url, start: starts[index], end: starts[index] + url.length
    })));
    expect(parseCssUrls(cssText)).toEqual(['b.css', 'a.png']);
  });
});
