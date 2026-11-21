import {afterEach, describe, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, parse, resolve} from 'node:path';
import {safeJoin, writeFile} from '../src/io.js';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map(root => fs.rm(root, {recursive: true, force: true})));
});

describe('safeJoin', () => {
  const root = parse(resolve('.')).root;

  test('allows output below the filesystem root', () => {
    expect(safeJoin(root, 'example.com/asset.bin'))
      .toBe(join(root, 'example.com', 'asset.bin'));
  });

  test('allows contained names beginning with two dots', () => {
    expect(safeJoin(join(root, 'archive'), '..assets/file.bin'))
      .toBe(join(root, 'archive', '..assets', 'file.bin'));
  });

  test('rejects an adjacent directory with the same prefix', () => {
    expect(() => safeJoin(join(root, 'archive'), '../archive-other/file.bin'))
      .toThrow('Resolved path escapes root');
  });
});

describe('direct writeFile', () => {
  async function directory() {
    const root = await fs.mkdtemp(join(tmpdir(), 'wse-write-'));
    scratch.push(root);
    return root;
  }

  test('creates missing parents for concurrent writes', async () => {
    const root = await directory();
    const files = Array.from({length: 8}, (_, index) => join(root, 'nested', 'dir', index + '.txt'));
    await Promise.all(files.map((file, index) => writeFile(file, String(index), 'utf8')));
    expect(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))))
      .toEqual(files.map((_, index) => String(index)));
  });

  test('preserves a view boundary and overwrites existing bytes', async () => {
    const root = await directory();
    const file = join(root, 'bytes.bin');
    await writeFile(file, 'long previous content', 'utf8');
    const bytes = new Uint8Array([9, 1, 2, 8]);
    await writeFile(file, new DataView(bytes.buffer, 1, 2), null);
    expect(await fs.readFile(file)).toEqual(Buffer.from([1, 2]));
  });

  test('keeps epoch zero timestamps', async () => {
    const file = join(await directory(), 'epoch.txt');
    await writeFile(file, '', 'utf8', 0);
    expect((await fs.stat(file)).mtimeMs).toBe(0);
  });

  test('propagates a non-directory parent error', async () => {
    const root = await directory();
    const parent = join(root, 'file');
    await fs.writeFile(parent, 'preserved');
    await expect(writeFile(join(parent, 'child'), 'body', 'utf8')).rejects.toMatchObject({code: 'ENOTDIR'});
    expect(await fs.readFile(parent, 'utf8')).toBe('preserved');
  });
});
