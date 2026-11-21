import {describe, expect, jest, test} from '@jest/globals';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {EventEmitter} from 'node:events';
// noinspection ES6PreferShortImport
import type {WorkerInfo} from '../../src/downloader/worker-pool.js';
// noinspection ES6PreferShortImport
import {WorkerPool} from '../../src/downloader/worker-pool.js';
import type {WorkerMessage} from '../../src/downloader/types.js';
import {WorkerMessageType} from '../../src/downloader/types.js';
import {getLogger, setLogger} from '../../src/logger/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EchoTask {value: number; hold?: boolean; log?: boolean}
type EchoMessage = WorkerMessage<{value: number; worker: number}>;
const echoWorker = join(__dirname, 'echo-worker.js');
const dispatchTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('worker-pool', function () {
  test.each([1, -1])('repeated singleton tasks share idle workers (maxLoad %s)', async maxLoad => {
    const pool = new WorkerPool<EchoTask, EchoMessage>(3, echoWorker, {}, maxLoad);
    try {
      await pool.ready;
      const counts = new Map<number, number>();
      for (let value = 0; value < 12; value++) {
        const result = await pool.submitTask({value});
        expect(result.body.value).toBe(value);
        counts.set(result.body.worker, (counts.get(result.body.worker) || 0) + 1);
      }
      expect([...counts.values()]).toEqual([4, 4, 4]);
      expect(pool.workers.map(worker => worker.completedTasks)).toEqual([4, 4, 4]);
      expect(Object.keys(pool.workingTasks)).toHaveLength(0);
    } finally { await pool.dispose(); }
  });

  test('active load takes priority over completion history', async () => {
    const pool = new WorkerPool<EchoTask, EchoMessage>(2, echoWorker, {});
    try {
      await pool.ready;
      const held = pool.submitTask({value: -1, hold: true});
      void held.catch(() => undefined);
      await dispatchTurn();
      const busy = pool.workers.find(worker => worker.load === 1)!;
      for (let value = 0; value < 5; value++) {
        const result = await pool.submitTask({value});
        expect(result.body.worker).not.toBe(busy.id);
      }
      expect(busy.completedTasks).toBe(0);
      busy.worker.postMessage({release: true});
      expect((await held).body.worker).toBe(busy.id);
    } finally { await pool.dispose(); }
  });

  test('a burst dispatches once and releases all completed task records', async () => {
    const pool = new WorkerPool<EchoTask, EchoMessage>(2, echoWorker, {});
    try {
      await pool.ready;
      const dispatch = jest.spyOn(pool, 'nextTask');
      const values = Array.from({length: 128}, (_, value) => value);
      const results = await Promise.all(values.map(value => pool.submitTask({value})));
      expect(results.map(result => result.body.value)).toEqual(values);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(Object.keys(pool.workingTasks)).toHaveLength(0);
      expect(pool.pendingTasks).toHaveLength(0);
      expect(pool.workers.map(worker => worker.load)).toEqual([0, 0]);
    } finally { await pool.dispose(); }
  });

  test('wrong-worker and duplicate completions cannot settle or recount tasks', async () => {
    const pool = new WorkerPool<EchoTask, EchoMessage>(2, echoWorker, {});
    try {
      await pool.ready;
      const held = pool.submitTask({value: 7, hold: true});
      void held.catch(() => undefined);
      await dispatchTurn();
      const owner = pool.workers.find(worker => worker.load === 1)!;
      const other = pool.workers.find(worker => worker !== owner)!;
      const message: EchoMessage = {taskId: pool.taskIdCounter,
        type: WorkerMessageType.Complete, body: {value: 99, worker: other.id}};
      pool.complete(other, message);
      expect(Object.keys(pool.workingTasks)).toHaveLength(1);
      expect(other.completedTasks).toBe(0);
      owner.worker.postMessage({release: true});
      expect((await held).body.value).toBe(7);
      pool.complete(owner, message);
      pool.onMessage(other, null as never);
      expect(owner.completedTasks).toBe(1);
      expect(pool.workers.map(worker => worker.load)).toEqual([0, 0]);
    } finally { await pool.dispose(); }
  });

  test('an error before online rejects readiness and queued tasks', async () => {
    const fake = new EventEmitter() as Worker;
    Object.defineProperty(fake, 'threadId', {value: 123});
    fake.terminate = jest.fn(async () => 0);
    const pool = new WorkerPool(1, echoWorker, {}, 1, () => fake);
    const task = expect(pool.submitTask({value: 1})).rejects.toThrow('startup failed');
    const ready = expect(pool.ready).rejects.toThrow('startup failed');
    const logger = getLogger();
    setLogger({...logger, error() { throw new Error('logger failed'); }});
    try {
      fake.emit('error', new Error('startup failed'));
      await ready;
      await task;
      expect(fake.listenerCount('online')).toBe(0);
    } finally {
      setLogger(logger);
      await pool.dispose();
    }
  });

  test('a later factory failure terminates workers already created', async () => {
    const worker = new Worker(echoWorker);
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    const terminate = jest.spyOn(worker, 'terminate');
    let created = 0;
    expect(() => new WorkerPool(2, echoWorker, {}, -1, () => {
      if (created++) throw new Error('factory failed');
      return worker;
    })).toThrow('factory failed');
    await exited;
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test('throwing consumer loggers do not interrupt completion', async () => {
    const logger = getLogger();
    setLogger({...logger, info() { throw new Error('logger failed'); }});
    const pool = new WorkerPool<EchoTask, EchoMessage>(1, echoWorker, {});
    try {
      expect((await pool.submitTask({value: 8, log: true})).body.value).toBe(8);
      const disposal = pool.dispose();
      expect(pool.dispose()).toBe(disposal);
      await disposal;
    } finally {
      setLogger(logger);
      await pool.dispose();
    }
  });

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
    const pool = new WorkerPool<EchoTask, EchoMessage>(1, echoWorker, {}, 1);
    try {
      await pool.ready;
      const task1 = pool.submitTask({value: 1, hold: true});
      const task1Rejected = expect(task1).rejects.toThrow('disposed');
      await dispatchTurn();
      const task2 = pool.submitTask({value: 2});
      const task2Rejected = expect(task2).rejects.toThrow('disposed');
      expect(Object.keys(pool.workingTasks)).toHaveLength(1);
      expect(pool.pendingTasks).toHaveLength(1);
      await pool.dispose();
      await task1Rejected;
      await task2Rejected;
      await expect(pool.submitTask({value: 3})).rejects.toThrow('disposed');
    } finally {
      await pool.dispose();
    }
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
