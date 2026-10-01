import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

if (!process.argv[2]) throw new Error('Expected the packed consumer lib/index.js path');
const entry = pathToFileURL(path.resolve(process.argv[2]));
const require = createRequire(entry);
const hasPeer = process.argv[3] === 'with-peer';
const library = await import(entry.href);
assert.equal(typeof library.createDefaultLogger().info, 'function');
if (!hasPeer) {
  assert.throws(() => require.resolve('log4js'), {code: 'MODULE_NOT_FOUND'});
  console.log(`${process.version}: package imports without the optional log4js peer`);
} else {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-log4js-peer-'));
  const {default: log4js} = await import(pathToFileURL(require.resolve('log4js')).href);
  try {
    const {createLog4jsLogger} = await import(new URL('./logger/log4js-adapter.js', entry).href);
    createLog4jsLogger(root).info('system.complete', 'peer integration passed');
    await new Promise((resolve, reject) => log4js.shutdown(error => error ? reject(error) : resolve()));
    assert.match(await fs.readFile(path.join(root, 'logs/complete.log'), 'utf8'), /peer integration passed/);
    console.log(`${process.version}: explicitly installed log4js peer writes through the adapter`);
  } finally {
    await new Promise(resolve => log4js.shutdown(resolve));
    await fs.rm(root, {recursive: true, force: true});
  }
}
