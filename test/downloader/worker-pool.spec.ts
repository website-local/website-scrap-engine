import {describe, expect, jest, test} from '@jest/globals';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
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
      expect(fn).toHaveBeenCalledTimes(2);
      // noinspection JSUnusedAssignment
      expect(error).toBeTruthy();
      expect(error?.message).toBe('Test worker error');
      await expect(pool.submitTask([1, 2])).rejects.toThrow('Test worker error');
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
      // Note that this is expected to fail here
      await expect(pool.submitTask([1, 2, b], [b as never]))
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
    const task1Rejected = expect(task1).rejects.toThrow('disposed');
    const task2Rejected = expect(task2).rejects.toThrow('disposed');
    await pool.dispose();
    await task1Rejected;
    await task2Rejected;
    await expect(pool.submitTask([3, 4])).rejects.toThrow('disposed');
  }, 10000);

  test.each([0, 1])(
    'pool rejects queued and future tasks after worker exit %s', async exitCode => {
      const pool = new WorkerPool(1,
        join(__dirname, 'exit-on-task-worker.js'), {exitCode}, 1);
      try {
        await pool.ready;
        const results = await Promise.allSettled([
          pool.submitTask([1, 2]),
          pool.submitTask([3, 4])
        ]);
        for (const result of results) {
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected') {
            expect(result.reason.message).toContain(`exited with code ${exitCode}`);
          }
        }
        expect(Object.keys(pool.workingTasks)).toHaveLength(0);
        expect(pool.pendingTasks).toHaveLength(0);
        await expect(pool.submitTask([5, 6]))
          .rejects.toThrow(`exited with code ${exitCode}`);
      } finally {
        await pool.dispose();
      }
    }, 10000);

  test('pool dispatches queued work to surviving workers', async () => {
    let workersCreated = 0;
    const pool = new WorkerPool(2,
      join(__dirname, 'delay-calc-worker.js'), {}, 1,
      (filename, options) => new Worker(workersCreated++ === 0 ?
        join(__dirname, 'exit-on-task-worker.js') : filename, options));
    try {
      await pool.ready;
      const results = await Promise.allSettled([
        pool.submitTask([1, 2]),
        pool.submitTask([2, 3]),
        pool.submitTask([4, 5])
      ]);
      expect(results[0].status).toBe('rejected');
      expect(results[1]).toMatchObject({status: 'fulfilled', value: {body: 5}});
      expect(results[2]).toMatchObject({status: 'fulfilled', value: {body: 9}});
      expect(Object.keys(pool.workingTasks)).toHaveLength(0);
      expect(pool.pendingTasks).toHaveLength(0);
      expect((await pool.submitTask([6, 7])).body).toBe(13);
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool rejects in-flight tasks when worker exits', async () => {

    const pool = new WorkerPool(1,
      join(__dirname, 'exit-on-task-worker.js'), {});
    try {
      await pool.ready;
      await expect(pool.submitTask([1, 2]))
        .rejects.toThrow('exited with code 1');
      expect(Object.keys(pool.workingTasks)).toHaveLength(0);
      expect(pool.workers[0].load).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 10000);
});
