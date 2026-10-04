import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

// Install the tarball into a separate consumer first. This check uses that
// installed runtime and its declarations, never a source/consumer module alias.
if (!process.argv[2]) throw new Error('Usage: node scripts/check-consumer.mjs CONSUMER [with-peer] [--smoke-only]');
const consumer = path.resolve(process.argv[2]);
const project = fileURLToPath(new URL('../', import.meta.url));
assert.notEqual(consumer, path.resolve(project), 'Use a separate packed consumer');
const entry = path.join(consumer, 'node_modules/website-scrap-engine/lib/index.js');
await fs.access(entry);
await fs.copyFile(new URL('./fixtures/consumer.ts', import.meta.url), path.join(consumer, 'wse-consumer-types.ts'));
const config = path.join(consumer, 'wse-consumer-tsconfig.json');
await fs.writeFile(config, JSON.stringify({compilerOptions: {
  module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true,
  noEmit: true, skipLibCheck: false, types: ['node'], typeRoots: [path.join(project, 'node_modules/@types')]
}, include: ['wse-consumer-types.ts']}, null, 2) + '\n');

const execute = promisify(execFile);
await execute(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'), '--project', config],
  {cwd: consumer, timeout: 60000});
const scripts = process.argv.includes('--smoke-only') ? ['runtime-smoke', 'runtime-log4js-peer'] : [
  'runtime-smoke', 'runtime-lifecycle', 'runtime-outcomes', 'runtime-failure-retry',
  'runtime-parent-publication', 'runtime-output-conflicts', 'runtime-discovery',
  'runtime-buffer-budget', 'runtime-adjustment', 'runtime-fast-retry',
  'runtime-native-http', 'runtime-single-import', 'runtime-log4js-peer'
];
if (process.platform === 'win32' && !process.argv.includes('--smoke-only')) scripts.push('runtime-windows-files');
const results = [];
for (const script of scripts) {
  const args = [path.join(project, 'test', script + '.js'),
    script === 'runtime-single-import' ? path.dirname(entry) : entry];
  if (script === 'runtime-log4js-peer' && process.argv.includes('with-peer')) args.push('with-peer');
  const env = script === 'runtime-native-http' ? {...process.env,
    NODE_EXTRA_CA_CERTS: path.join(project, 'test/fixtures/native-http-cert.pem')} : process.env;
  const result = await execute(process.execPath, args,
    {cwd: consumer, env, timeout: 60000, maxBuffer: 1024 * 1024});
  results.push({script, output: result.stdout.trim()});
  process.stderr.write(script + ': passed\n');
}
console.log(JSON.stringify({node: process.version, consumer, entry, strictDeclarations: true,
  loggingPeer: process.argv.includes('with-peer'), results}, null, 2));
