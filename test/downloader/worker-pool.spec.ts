import { join } from 'path';
// noinspection ES6PreferShortImport
import {WorkerPool} from '../../src/downloader/worker-pool';

describe('worker-pool', function () {
  test('pool would work correctly', async done => {
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
      done();
    } finally {
      await pool.dispose();
    }
  });
});
