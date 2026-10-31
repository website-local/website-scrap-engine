import {describe, expect, jest, test} from '@jest/globals';
import {load as cheerioLoad} from 'cheerio';
import {disposeHtmlResource, load, prepareHtmlParser} from '../src/cheerio.js';
import {defaultDownloadOptions, mergeOverrideOptions} from '../src/options.js';
import {defaultLifeCycle} from '../src/life-cycle/default-life-cycle.js';
import {createResource, ResourceType} from '../src/resource.js';

describe('downstream HTML loader', () => {
  test('forwards content, parse options and fragment mode without binding the loader', () => {
    const content = Buffer.from('<Item>value</Item>');
    const parseOptions = {xml: true};
    const document = cheerioLoad(content, parseOptions, false);
    const customLoad = jest.fn(function (this: unknown, ...args: Parameters<typeof cheerioLoad>) {
      expect(this).toBeUndefined();
      expect(args).toEqual([content, parseOptions, false]);
      expect(args[0]).toBe(content);
      expect(args[1]).toBe(parseOptions);
      return document;
    });
    expect(load(content, parseOptions, false, {loadHtml: customLoad})).toBe(document);
    expect(customLoad).toHaveBeenCalledTimes(1);
  });

  test('leaves supplied loader initialization to the application', () => {
    const customLoad = jest.fn(cheerioLoad);
    const options = {loadHtml: customLoad};
    expect(prepareHtmlParser(options)).toBeUndefined();
    expect(customLoad).not.toHaveBeenCalled();
    expect(load('<p>custom</p>', undefined, undefined, options)('p').text()).toBe('custom');
    expect(customLoad).toHaveBeenCalledTimes(1);
  });

  test('retains the function through option normalization and reads later replacements', () => {
    const first = jest.fn(cheerioLoad), second = jest.fn(cheerioLoad);
    const options = mergeOverrideOptions(defaultDownloadOptions({
      ...defaultLifeCycle(), localRoot: 'offline', loadHtml: first
    }), {concurrency: 2});
    expect(options.loadHtml).toBe(first);
    load('<p>first</p>', undefined, undefined, options);
    options.loadHtml = second;
    load('<p>second</p>', undefined, undefined, options);
    options.loadHtml = undefined;
    expect(load('<p>default</p>', undefined, undefined, options)('p').text()).toBe('default');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('keeps independently supplied loaders and resource disposal separate across awaits', async () => {
    const makeResource = () => createResource({type: ResourceType.Html, depth: 0,
      url: 'https://example.test/', refUrl: 'https://example.test/', localRoot: 'offline'});
    const first = makeResource(), second = makeResource(), nested = makeResource();
    const firstDocument: ReturnType<typeof cheerioLoad> & {dispose?: () => void} = cheerioLoad('<p>first</p>');
    const secondDocument: ReturnType<typeof cheerioLoad> & {dispose?: () => void} = cheerioLoad('<p>second</p>');
    firstDocument.dispose = jest.fn();
    secondDocument.dispose = jest.fn();
    await Promise.all([
      (async () => {
        first.meta.doc = load('', undefined, undefined, {loadHtml: () => firstDocument});
        nested.meta.doc = first.meta.doc.load('<p>nested</p>');
        await Promise.resolve();
        expect(first.meta.doc).toBe(firstDocument);
        expect(nested.meta.doc('p').text()).toBe('nested');
        await disposeHtmlResource(first);
        expect(nested.meta.doc('p').text()).toBe('nested');
        await disposeHtmlResource(nested);
      })(),
      (async () => {
        second.meta.doc = load('', undefined, undefined, {loadHtml: () => secondDocument});
        await Promise.resolve();
        expect(second.meta.doc).toBe(secondDocument);
        await disposeHtmlResource(second);
      })()
    ]);
    expect(first.meta.doc).toBeUndefined();
    expect(second.meta.doc).toBeUndefined();
    expect(nested.meta.doc).toBeUndefined();
    expect(firstDocument.dispose).toHaveBeenCalledTimes(1);
    expect(secondDocument.dispose).toHaveBeenCalledTimes(1);
  });

  test('propagates the original synchronous loader failure', () => {
    const error = new Error('custom parse failed');
    expect(() => load('input', undefined, undefined, {loadHtml: () => { throw error; }})).toThrow(error);
  });

  test.each([null, false, 1, 'cheerio', {}])('rejects a non-function loader at normalization: %p', value => {
    const options = {...defaultLifeCycle()};
    Reflect.set(options, 'loadHtml', value);
    expect(() => defaultDownloadOptions(options)).toThrow('loadHtml must be a function');
  });
});
