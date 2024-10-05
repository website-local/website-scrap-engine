// noinspection ES6PreferShortImport
import {
  binaryExtension,
  detectResourceType
} from '../../src/life-cycle/detect-resource-type.js';
import {ResourceType} from '../../src/resource.js';

describe('detect-resource-type', function () {

  test('detect simple site map', () => {
    expect(detectResourceType('/sitemaps/sitemap.xml', ResourceType.Html))
      .toBe(ResourceType.SiteMap);
    expect(detectResourceType('/sitemaps/sitemap.xml', ResourceType.Binary))
      .toBe(ResourceType.SiteMap);
    expect(detectResourceType('/sitemaps/sitemap.xml', ResourceType.Css))
      .toBe(ResourceType.SiteMap);
  });

  test('detect binary out of html', () => {
    expect(detectResourceType('1.jpg', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType('//////1.png', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType('//1.html/..///1.png', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType('http://example.com/1.gif', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType(
      'http://example.com/1.jpeg?aaa.css=bbb.html', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType(
      'http://example.com/1.jpeg?aaa.css=bbb.html#1.1=1', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType(
      'http://example.com/1.jpeg?#1.1=1', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType(
      'http://example.com/1.PnG?#1.1=1', ResourceType.Html))
      .toBe(ResourceType.Binary);
    expect(detectResourceType(
      'http://example.com/1.pNG#1.html', ResourceType.Html))
      .toBe(ResourceType.Binary);
    Object.keys(binaryExtension).forEach((ext) => {
      expect(detectResourceType(
        `http://example.com/1.${ext}?aaa.css=bbb.html`, ResourceType.Html))
        .toBe(ResourceType.Binary);
    });
    expect(detectResourceType(
      'http://example.com/?aaa=1.jpg', ResourceType.Html))
      .toBe(ResourceType.Html);
    expect(detectResourceType(
      'http://example.com/#!/1.jpg', ResourceType.Html))
      .toBe(ResourceType.Html);
  });

  test('detect css out of html', () => {
    expect(detectResourceType('1.css', ResourceType.Html))
      .toBe(ResourceType.Css);
    expect(detectResourceType('//////1.css', ResourceType.Html))
      .toBe(ResourceType.Css);
    expect(detectResourceType('//1.html/..///1.css', ResourceType.Html))
      .toBe(ResourceType.Css);
    expect(detectResourceType('http://example.com/1.css', ResourceType.Html))
      .toBe(ResourceType.Css);
    expect(detectResourceType(
      'http://example.com/1.css?aaa.css=bbb.png', ResourceType.Html))
      .toBe(ResourceType.Css);
  });

  // https://github.com/website-local/website-scrap-engine/issues/3
  // 791de1e060a91fb642845062b04909fb5ab1e32b
  test('detect svg out of html', () => {
    expect(detectResourceType('1.svg', ResourceType.Html))
      .toBe(ResourceType.Svg);
    expect(detectResourceType('//////1.svg', ResourceType.Html))
      .toBe(ResourceType.Svg);
    expect(detectResourceType('//1.html/..///1.svg', ResourceType.Html))
      .toBe(ResourceType.Svg);
    expect(detectResourceType('http://example.com/1.svg', ResourceType.Html))
      .toBe(ResourceType.Svg);
    expect(detectResourceType(
      'http://example.com/1.svg?aaa.css=bbb.png', ResourceType.Html))
      .toBe(ResourceType.Svg);
  });
});
