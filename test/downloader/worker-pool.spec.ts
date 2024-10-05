import {describe, expect, jest, test} from '@jest/globals';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
// noinspection ES6PreferShortImport
import type {WorkerInfo} from '../../src/downloader/worker-pool.js';
// noinspection ES6PreferShortImport
import {WorkerPool} from '../../src/downloader/worker-pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('worker-pool', function () {
  test('pool would work correctly', async () => {
    const cases: number[][] = [];
    for (let i = 0; i < 100; i++) {
      cases.push([Math.random() * 65535 | 0, Math.random() * 65535 | 0]);
    }
    const expected = [];
    for (let i = 0; i < cases.length; i++) {
      expected[i] = cases[i][0] + cases[i][1];
    }
    const pool = new WorkerPool(2,
      join(__dirname, 'delay-calc-worker.js'), {});
    try {
      expect(pool.workers.length).toBe(2);
      expect(pool.maxLoad).toBe(-1);
      const results = await Promise.all(cases.map(c => pool.submitTask(c)));
      expect(results.map(res => res.body)).toStrictEqual(expected);
      const badResult = await pool.submitTask([12, NaN]);
      expect(badResult.body).toBeNaN();
      expect(badResult.error).toBeTruthy();
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool logs worker error', async () => {
    const fn = jest.fn();
    let error: Error | undefined;

    class Pool extends WorkerPool {
      workerOnError(info: WorkerInfo, err: Error) {
        super.workerOnError(info, err);
        fn(err);
        console.log(info.id, err);
        error = err;
      }
    }

    const pool = new Pool(2,
      join(__dirname, 'error-worker.js'), {});
    try {
      await pool.ready;
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(fn).toBeCalledTimes(2);
      // noinspection JSUnusedAssignment
      expect(error).toBeTruthy();
      expect(error?.message).toBe('Test worker error');
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool rejects bad argument', async () => {

    const pool = new WorkerPool(1,
      join(__dirname, 'delay-calc-worker.js'), {});
    try {
      await pool.ready;
      const b = Buffer.alloc(10);
      await expect(pool.submitTask([1, 2, b], [b]))
        .rejects.toThrow();
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool rejects unfinished tasks on dispose', async () => {

    const pool = new WorkerPool(1,
      join(__dirname, 'delay-calc-worker.js'), {});
    await pool.ready;
    const task1 = pool.submitTask([1, 2]);
    const task2 = pool.submitTask([2, 2]);
    await pool.dispose();
    await expect(task1).rejects.toThrow('disposed');
    await expect(task2).rejects.toThrow('disposed');
  }, 10000);
});
