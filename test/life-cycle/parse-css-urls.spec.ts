import {describe, expect, test} from '@jest/globals';
import parseCssUrls from '../../src/life-cycle/parse-css-urls.js';
import {parseCssUrlMatches} from '../../src/life-cycle/parse-css-urls.js';
import {processCssText} from '../../src/life-cycle/process-css.js';
import {defaultLifeCycle} from '../../src/life-cycle/default-life-cycle.js';
import {defaultDownloadOptions} from '../../src/options.js';
import {PipelineExecutorImpl} from '../../src/downloader/pipeline-executor-impl.js';
import {createResource, ResourceType} from '../../src/resource.js';
import type {Resource} from '../../src/resource.js';

describe('parseCssUrls', () => {
  test.each([
    ['url("', 'url', '")'],
    ['url(\'', 'url', '\')'],
    ['url(', 'url', ')'],
    ['@import "', 'import', '";'],
    ['@import \'', 'import', '\';'],
    ['@import ', 'import', ';'],
    ['URL(  "', 'URL', '"  )'],
    ['url(  "', ' ', '"  )'],
    ['@import  \'', ' ', '\';']
  ])('locates the argument in %s%s%s', (before, url, after) => {
    const prefix = '/* url("ignored") */\n';
    const css = prefix + before + url + after;
    const start = prefix.length + before.length;
    expect(parseCssUrlMatches(css)).toEqual([{url, start, end: start + url.length}]);
  });

  test('rewrites repeated URLs named url and import without replacing CSS syntax', async () => {
    const css = '@import "import";a{x:url("url");y:url(url)}';
    const options = defaultDownloadOptions({...defaultLifeCycle(), processBeforeDownload: [res => {
      res.replacePath = 'assets/' + res.rawUrl;
      return res;
    }]});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    const parent = {...createResource({type: ResourceType.Css, depth: 0,
      url: 'https://example.test/style.css', refUrl: 'https://example.test/', localRoot: 'output'}), body: css};
    const resources: Resource[] = [];
    expect(await processCssText(css, parent, options, pipeline, 1, resources))
      .toBe('@import "assets/import";a{x:url("assets/url");y:url(assets/url)}');
    expect(resources.map(res => res.rawUrl)).toEqual(['import', 'url']);
  });

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
