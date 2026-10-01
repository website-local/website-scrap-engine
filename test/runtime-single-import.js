import assert from 'node:assert/strict';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// A fresh process fails if the single-thread entry graph imports worker code.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (/\\/(?:multi|worker[^/]*|logger-worker)\\.js$/.test(resolved.url)) {
    throw new Error('Single-thread entry imported worker code: ' + resolved.url);
  }
  return resolved;
}`));
const root = pathToFileURL(path.resolve(process.argv[2]) + path.sep).href;
const {SingleThreadDownloader} = await import(new URL('downloader/single.js', root));
const {defaultLifeCycle} = await import(new URL('life-cycle/default-life-cycle.js', root));
const {defaultDownloadOptions} = await import(new URL('options.js', root));
assert.equal(typeof SingleThreadDownloader, 'function');
assert.ok(defaultDownloadOptions(defaultLifeCycle()).download.length);
