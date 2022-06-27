import {sources} from '../src/sources';
import {load} from 'cheerio';
import {ResourceType} from '../src/resource';

describe('sources', function () {
  test('source should contains type', () => {
    for (const source of sources) {
      expect(source.type).toBeTruthy();
      expect(source.type in ResourceType).toBeTruthy();
    }
  });
  test('source should contains valid selector', () => {
    const $ = load('<html lang="en"></html>');
    for (const source of sources) {
      expect(source.selector).toBeTruthy();
      // expect no error thrown
      $(source.selector);
    }
  });
});
