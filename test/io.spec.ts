import {afterEach, describe, expect, jest, test} from '@jest/globals';
import fs from 'node:fs';
import {mkdirRetry} from '../src/io.js';

afterEach(() => jest.restoreAllMocks());

describe('mkdirRetry compatibility', () => {
  test('retries a failed recursive mkdir with the supplied attempt limit', async () => {
    const mkdir = jest.spyOn(fs.promises, 'mkdir')
      .mockRejectedValueOnce(new Error('transient mkdir failure'))
      .mockResolvedValueOnce(undefined);

    await mkdirRetry('output/nested', 2);

    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(mkdir).toHaveBeenLastCalledWith('output/nested', {recursive: true});
  });

  test('rejects after the supplied number of attempts', async () => {
    const error = new Error('mkdir failure');
    const mkdir = jest.spyOn(fs.promises, 'mkdir').mockRejectedValue(error);

    await expect(mkdirRetry('output/nested', 2)).rejects.toBe(error);
    expect(mkdir).toHaveBeenCalledTimes(2);
  });

  test('preserves the zero-attempt behavior', async () => {
    const mkdir = jest.spyOn(fs.promises, 'mkdir');

    await expect(mkdirRetry('output/nested', 0)).resolves.toBeUndefined();
    expect(mkdir).not.toHaveBeenCalled();
  });
});
