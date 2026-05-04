import {describe, expect, test} from '@jest/globals';
import parseCssUrls from '../../src/life-cycle/parse-css-urls.js';

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
});
