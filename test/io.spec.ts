import {describe, expect, test} from '@jest/globals';
import {join, parse, resolve} from 'node:path';
import {safeJoin} from '../src/io.js';

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
