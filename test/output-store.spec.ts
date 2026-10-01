import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {publishFile} from '../src/output-store.js';
import {writeFile} from '../src/io.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(process.cwd(), '.wse-output-test-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

describe('staged file publication', () => {
  test('keeps the previous file visible until all bytes are written', async () => {
    const destination = join(root, 'asset');
    await fs.writeFile(destination, 'old');
    await publishFile(destination, async staging => {
      await fs.writeFile(staging, 'new');
      expect(await fs.readFile(destination, 'utf8')).toBe('old');
      await fs.appendFile(staging, ' complete');
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('new complete');
    expect(await fs.readdir(root)).toEqual(['asset']);
  });

  test.each(['error', 'cancel'])(
    '%s after partial writing preserves the destination and removes staging', async mode => {
      const destination = join(root, 'asset');
      await fs.writeFile(destination, 'cached');
      const controller = new AbortController();
      const failure = new Error('writer stopped');
      await expect(publishFile(destination, async staging => {
        await fs.writeFile(staging, 'partial');
        if (mode === 'error') throw failure;
        controller.abort(failure);
      }, controller.signal)).rejects.toBe(failure);
      expect(await fs.readFile(destination, 'utf8')).toBe('cached');
      expect(await fs.readdir(root)).toEqual(['asset']);
    });

  test('failed rename cleans staging without removing the destination', async () => {
    const destination = join(root, 'asset');
    await fs.mkdir(destination);
    await fs.writeFile(join(destination, 'existing'), 'keep');
    await expect(publishFile(destination, staging => fs.writeFile(staging, 'new'))).rejects.toThrow();
    expect(await fs.readFile(join(destination, 'existing'), 'utf8')).toBe('keep');
    expect(await fs.readdir(root)).toEqual(['asset']);
  });

  test('an already cancelled write creates no directories', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(publishFile(join(root, 'nested', 'asset'),
      staging => fs.writeFile(staging, 'new'), controller.signal)).rejects.toThrow('cancelled');
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('the buffered writer preserves binary view bounds and epoch timestamps', async () => {
    const destination = join(root, 'nested', 'asset');
    const view = new DataView(new Uint8Array([99, 0, 255, 88]).buffer, 1, 2);
    await writeFile(destination, view, null, 0, 0);
    expect(await fs.readFile(destination)).toEqual(Buffer.from([0, 255]));
    expect((await fs.stat(destination)).mtimeMs).toBe(0);
    expect(await fs.readdir(join(root, 'nested'))).toEqual(['asset']);
  });
});
