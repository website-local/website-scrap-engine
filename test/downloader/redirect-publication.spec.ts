import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
let root: string;
let buildRoot: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(projectRoot, '.wse-redirect-test-'));
  buildRoot = path.join(root, 'lib');
  await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'node_modules/typescript/bin/tsc'), '--project', path.join(projectRoot, 'tsconfig.json'),
    '--outDir', buildRoot, '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false'
  ], {cwd: projectRoot, timeout: 30000});
}, 30000);
afterAll(async () => { if (root) await fs.rm(root, {recursive: true, force: true}); });

test.each([
  ['single', 'direct'], ['single', 'atomic'], ['worker', 'direct'], ['worker', 'atomic']
])('canonical redirected bytes preserve conflict checks in %s/%s', async (topology, writes) => {
  const result = await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-redirect-publication.js'), path.join(buildRoot, 'index.js'), topology, writes
  ], {cwd: projectRoot, timeout: 20000});
  expect(JSON.parse(result.stdout)).toMatchObject({topology, atomic: writes === 'atomic', checks: expect.any(Array)});
}, 25000);

test.each([
  ['single', 'direct'], ['single', 'atomic'], ['worker', 'direct'], ['worker', 'atomic']
])('HTML redirects preserve canonical pages and exclusive stubs in %s/%s', async (topology, writes) => {
  const result = await promisify(execFile)(process.execPath, [
    path.join(projectRoot, 'test/runtime-html-redirect-publication.js'), path.join(buildRoot, 'index.js'), topology, writes
  ], {cwd: projectRoot, timeout: 20000});
  expect(JSON.parse(result.stdout)).toMatchObject({topology, atomic: writes === 'atomic',
    checks: expect.any(Array), documents: 16});
}, 25000);
