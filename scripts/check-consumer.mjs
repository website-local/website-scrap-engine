import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

if (!process.argv[2]) throw new Error('Usage: check-consumer.mjs CONSUMER [--types-only] [--smoke-only] [--grovedom]');
const consumer = path.resolve(process.argv[2]);
const project = fileURLToPath(new URL('../', import.meta.url));
assert.notEqual(consumer, path.resolve(project), 'Use a separate packed consumer');
const entry = path.join(consumer, 'node_modules/website-scrap-engine/lib/index.js');
await fs.access(entry);
const execute = promisify(execFile);
const require = createRequire(entry);
const compilerOptions = {module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022',
  strict: true, noEmit: true, skipLibCheck: false, types: ['node'],
  typeRoots: [path.join(project, 'node_modules/@types')]};
// Resolve Cheerio's dependency even when npm keeps it nested. The development
// alias does not export package.json; its real declarations come from @types/node.
// Normal consumers use Undici itself.
try {
  const cheerioRequire = createRequire(require.resolve('cheerio'));
  const undiciEntry = cheerioRequire.resolve('undici');
  const undici = JSON.parse(await fs.readFile(path.join(path.dirname(undiciEntry), 'package.json'), 'utf8'));
  if (undici.name === '@favware/skip-dependency') {
    compilerOptions.paths = {undici: [path.join(project, 'node_modules/undici-types/index.d.ts')]};
  }
} catch { /* The compiler reports missing real consumer dependencies. */ }
const scratch = await fs.mkdtemp(path.join(consumer, '.wse-consumer-'));
const source = path.join(scratch, 'wse-consumer-types.ts');
const config = path.join(scratch, 'wse-consumer-tsconfig.json');
try {
  await fs.copyFile(new URL('./fixtures/consumer.ts', import.meta.url), source);
  await fs.writeFile(config, JSON.stringify({compilerOptions, include: ['wse-consumer-types.ts']}, null, 2));
  await execute(process.execPath, [...process.execArgv, path.join(project, 'node_modules/typescript/bin/tsc'), '-p', config],
    {cwd: consumer, timeout: 40000});
  const results = [];
  if (!process.argv.includes('--types-only')) {
    const checks = [['runtime-smoke', []]];
    if (!process.argv.includes('--smoke-only')) checks.push(['runtime-native-http', []]);
    if (process.argv.includes('--grovedom')) {
      checks.push(['runtime-html-parser', [require.resolve('grovedom')]]);
    }
    for (const [script, extra] of checks) {
      const env = script === 'runtime-native-http' ? {...process.env,
        NODE_EXTRA_CA_CERTS: path.join(project, 'test/fixtures/native-http-cert.pem')} : process.env;
      const result = await execute(process.execPath, [...process.execArgv, path.join(project, 'test', script + '.js'), entry, ...extra],
        {cwd: consumer, env, timeout: 30000, maxBuffer: 1024 * 1024});
      results.push({script, output: result.stdout.trim()});
    }
  }
  console.log(JSON.stringify({node: process.version, strictDeclarations: true, results}));
} finally {
  await fs.rm(scratch, {recursive: true, force: true});
}
