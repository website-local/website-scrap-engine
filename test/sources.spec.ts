import {sources} from '../src/sources';
import cheerio from 'cheerio';

describe('sources', function () {
  test('source should contains type', () => {
    for (const source of sources) {
      expect(source.type).toBeTruthy();
    }
  });
  test('source should contains valid selector', () => {
    const $ = cheerio.load('<html lang="en"></html>');
    for (const source of sources) {
      expect(source.selector).toBeTruthy();
      // expect no error thrown
      $(source.selector);
    }
  });
});
