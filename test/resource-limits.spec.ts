import {expect, test} from '@jest/globals';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {buffer} from 'node:stream/consumers';
import {checkResourceBody, limitResourceStream, readResourceFile, resourceBodyBytes} from '../src/resource-limits.js';
import {createResource, ResourceType} from '../src/resource.js';

test('buffered limits count encoded bytes and only the visible part of a view', () => {
  const res = createResource({type: ResourceType.Binary, depth: 0, url: 'https://example.org/audio',
    refUrl: 'https://example.org/', localRoot: 'output', encoding: 'utf8'});
  res.body = 'é';
  expect(checkResourceBody(res, 2)).toBe(true);
  expect(checkResourceBody(res, 1)).toBe(false);
  expect(res.shouldBeDiscardedFromDownload).toBe(true);
  expect(res.meta).toMatchObject({resourceSize: 2, resourceSizeLimit: 1});
  expect(resourceBodyBytes(new DataView(new ArrayBuffer(16), 4, 2), null)).toBe(2);
  expect(resourceBodyBytes('Y Q==', 'base64')).toBe(1);
  expect(resourceBodyBytes('ffxx', 'hex')).toBe(1);
});

test('resumed stream accepts the exact limit and rejects the first overflowing chunk', async () => {
  expect(await buffer(Readable.from(['a', 'b']).pipe(limitResourceStream(4, 2)))).toEqual(Buffer.from('ab'));
  await expect(buffer(Readable.from(['a', 'b']).pipe(limitResourceStream(3, 2))))
    .rejects.toMatchObject({code: 'ERR_RESOURCE_SIZE_LIMIT', limit: 3, actual: 4});
  expect(() => limitResourceStream(1, 2)).toThrow('exceeds');
  expect(() => limitResourceStream(1, -1)).toThrow(RangeError);
});

test('local reads check bytes before decoding and propagate cancellation and read errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'byte-limit-'));
  try {
    const file = join(dir, 'input');
    const text = 'é'.repeat(32769);
    await writeFile(file, text);
    expect(await readResourceFile(file, 'utf8', 65538)).toBe(text);
    expect(await readResourceFile(file, null, 65537)).toBeUndefined();
    await expect(readResourceFile(file, null, 0, AbortSignal.abort())).rejects.toMatchObject({code: 'ABORT_ERR'});
    await expect(readResourceFile(join(dir, 'missing'), null, 1)).rejects.toMatchObject({code: 'ENOENT'});
    await writeFile(file, '');
    expect(await readResourceFile(file, null, 0)).toEqual(Buffer.alloc(0));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
