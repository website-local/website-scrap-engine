import {afterEach, describe, expect, test} from '@jest/globals';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import URI from '../src/uri.js';

interface UpstreamTest {
  group: string;
  name: string;
  callback: string;
  assertions: number;
  omittedInternalAssertions: string[];
}
interface Resolution {
  name: string;
  url: string;
  base: string;
  result?: string;
  throws?: boolean;
  nativeDifference?: 'absolute-base-required' | 'relative-reference-retained' | 'authority-retained';
}
const querySuite = JSON.parse(readFileSync(new URL('./fixtures/urijs/query-tests.json', import.meta.url), 'utf8')) as {
  tests: UpstreamTest[];
};
const resolution = JSON.parse(readFileSync(new URL('./fixtures/urijs/resolution.json', import.meta.url), 'utf8')) as {
  absoluteTo: Resolution[];
  relativeTo: Resolution[];
};

describe('URIjs 1.19.11 upstream query and RFC resolution suites', () => {
  afterEach(() => {
    URI.escapeQuerySpace = true;
    URI.duplicateQueryParameters = false;
  });

  for (const entry of querySuite.tests) {
    test(`${entry.group}: ${entry.name}`, () => {
      let assertions = 0;
      const checks = {ok: assert.ok, equal: assert.equal, strictEqual: assert.strictEqual,
        deepEqual: assert.deepEqual, raises: assert.throws};
      const functions = Object.values(checks).map(fn => (...args: unknown[]) => {
        assertions++;
        Reflect.apply(fn, undefined, args);
      });
      // Pinned, reviewed upstream test bodies; execute in this realm so RegExp
      // literals retain the same instanceof semantics as the implementation.
      const run = new Function('URI', ...Object.keys(checks), 'return (' + entry.callback + ')();');
      run(URI, ...functions);
      expect(assertions).toBe(entry.assertions);
    });
  }
});

describe('URIjs 1.19.11 resolution vectors and explicit native differences', () => {
  for (const kind of ['string', 'wrapper'] as const) {
    for (const entry of resolution.absoluteTo) {
      const relativeBase = entry.nativeDifference === 'absolute-base-required';
      test(`absoluteTo ${kind}: ${entry.name}${relativeBase ? ' (requires absolute base)' : ''}`, () => {
        const base = kind === 'wrapper' ? URI(entry.base) : entry.base;
        const uri = URI(entry.url);
        const original = uri.href();
        if (relativeBase) assert.throws(() => uri.absoluteTo(base), {name: 'TypeError', code: 'ERR_INVALID_URL'});
        else {
          const result = uri.absoluteTo(base);
          expect(result.href()).toBe(entry.result);
          expect(result).not.toBe(uri);
        }
        expect(uri.href()).toBe(original);
        expect(String(base)).toBe(entry.base);
      });
    }
    for (const entry of resolution.relativeTo) {
      // The wrapper retains its reference when the base/reference lacks a
      // scheme or when authority/credentials differ. URIjs can shorten these.
      const retained = entry.nativeDifference !== undefined;
      test(`relativeTo ${kind}: ${entry.name}${retained ? ' (reference retained)' : ''}`, () => {
        const base = kind === 'wrapper' ? URI(entry.base) : entry.base;
        const result = URI(entry.url).relativeTo(base);
        expect(result.href()).toBe(retained ? entry.url : entry.result);
        expect(String(base)).toBe(entry.base);
      });
    }
  }
});
