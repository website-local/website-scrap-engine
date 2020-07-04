import {arrayToMap, escapePath, isSiteMap, sleep} from '../src/util';

describe('util', function () {
  test('sleep', async done => {
    const tolerance = 2;
    let ts: number;
    const testSleepTimes = [0, 1, 6, 11, 3, 14];
    for (const time of testSleepTimes) {
      ts = Date.now();
      await sleep(time);
      expect(Date.now() - ts + tolerance).toBeGreaterThanOrEqual(time);
    }
    done();
  });

  test('escapePath', () => {
    expect(escapePath(':*?"<>|&'))
      .toBe('________');
    expect(escapePath(encodeURIComponent(':*?"<>|&')))
      .toBe('________');
  });

  test('isSiteMap', () => {
    expect(isSiteMap('aaa/~!@#$%^&/*()_+=-]/[{}\\|":>?<')).toBeFalsy();
    expect(isSiteMap('http://example.com')).toBeFalsy();
    expect(isSiteMap()).toBeFalsy();
    expect(isSiteMap('')).toBeFalsy();
    expect(isSiteMap('null')).toBeFalsy();
    expect(isSiteMap('http://example.com/rss.xml')).toBeFalsy();
    expect(isSiteMap('http://example.com/sitemaps/sitemap.xml')).toBeTruthy();
    expect(isSiteMap('http://example.com/sitemaps/sitemap_other.xml'))
      .toBeTruthy();
  });

  test('arrayToMap', () => {
    expect(arrayToMap([1, '1', '3', '5', 'aaa'])).toStrictEqual({
      '1': 1,
      '3': 1,
      '5': 1,
      'aaa': 1
    });
  });
});
