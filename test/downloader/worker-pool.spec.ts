import {describe, expect, jest, test} from '@jest/globals';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {setLogger} from '../../src/logger/logger.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';
import type {Logger} from '../../src/logger/types.js';
// noinspection ES6PreferShortImport
import type {WorkerInfo} from '../../src/downloader/worker-pool.js';
// noinspection ES6PreferShortImport
import {WorkerPool} from '../../src/downloader/worker-pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('worker-pool', function () {
  test('batches burst dispatch while yielding and respecting worker capacity', async () => {
    const pool = new WorkerPool(2, join(__dirname, 'task-deadline-worker.js'), {hang: true}, 2);
    try {
      await pool.ready;
      const next = jest.spyOn(pool, 'nextTask');
      const owners = new Map<number, WorkerInfo>();
      const dispatched: number[] = [];
      const tasks = Array.from({length: 6}, (_, index) => {
        let id = 0;
        return pool.submitTask(index, undefined, value => { id = value; }, worker => {
          owners.set(id, pool.workers.find(info => info.worker === worker)!);
          dispatched.push(id);
        });
      });
      expect(pool.workingTasks.size).toBe(0);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(next).toHaveBeenCalledTimes(1);
      expect(dispatched).toEqual([1, 2, 3, 4]);
      expect(pool.workers.map(info => info.load)).toEqual([2, 2]);
      const complete = (id: number) => pool.complete(owners.get(id)!, {type: 1, taskId: id, body: id});
      complete(1);
      complete(2);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(next).toHaveBeenCalledTimes(2);
      expect(dispatched).toEqual([1, 2, 3, 4, 5, 6]);
      expect(pool.workers.map(info => info.load)).toEqual([2, 2]);
      for (const id of [...pool.workingTasks.keys()]) complete(id);
      expect((await Promise.all(tasks)).map(result => result.body)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(pool.pendingTasks).toHaveLength(0);
      expect(pool.workers.map(info => info.load)).toEqual([0, 0]);
    } finally { await pool.dispose(); }
  });

  test('work submitted during dispatch gets another pass before a completion', async () => {
    const pool = new WorkerPool(1, join(__dirname, 'task-deadline-worker.js'), {hang: true}, 2);
    try {
      await pool.ready;
      let child: ReturnType<typeof pool.submitTask> | undefined;
      const first = pool.submitTask(1, undefined, undefined, () => { child = pool.submitTask(2); });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(pool.workingTasks.size).toBe(1);
      expect(pool.pendingTasks).toHaveLength(1);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(pool.workingTasks.size).toBe(2);
      expect(pool.pendingTasks).toHaveLength(0);
      for (const taskId of pool.workingTasks.keys()) {
        pool.complete(pool.workers[0], {type: 1, taskId, body: taskId});
      }
      await expect(first).resolves.toMatchObject({body: 1});
      await expect(child).resolves.toMatchObject({body: 2});
    } finally { await pool.dispose(); }
  });

  test('successful completion clears an enabled deadline before later work', async () => {
    const pool = new WorkerPool(1, join(__dirname, 'task-deadline-worker.js'), {hang: true}, 1,
      undefined, {taskTimeout: 100});
    try {
      await pool.ready;
      const first = pool.submitTask(1);
      pool.nextTask();
      pool.complete(pool.workers[0], {type: 1, taskId: 1, body: 1});
      await first;
      await new Promise(resolve => setTimeout(resolve, 150));
      const second = pool.submitTask(2);
      pool.nextTask();
      pool.complete(pool.workers[0], {type: 1, taskId: 2, body: 2});
      await expect(second).resolves.toMatchObject({body: 2});
    } finally { await pool.dispose(); }
  });

  test('dispatch callbacks identify the owner after successful transport', async () => {
    const pool = new WorkerPool(1, join(__dirname, 'delay-calc-worker.js'), {});
    try {
      await pool.ready;
      let taskId = 0;
      const dispatched = jest.fn((worker: Worker) => {
        expect(pool.workingTasks.has(taskId)).toBe(true);
        expect(worker).toBe(pool.workers[0].worker);
      });
      const result = await pool.submitTask([1, 2], undefined, id => { taskId = id; }, dispatched);
      expect(result.body).toBe(3);
      expect(dispatched).toHaveBeenCalledTimes(1);
      dispatched.mockClear();
      await expect(pool.submitTask([() => {}], undefined, undefined, dispatched)).rejects.toThrow();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { await pool.dispose(); }
  });

  test('dispatch callback failure retires its worker and keeps undispatched work progressing', async () => {
    const pool = new WorkerPool(2, join(__dirname, 'delay-calc-worker.js'), {});
    try {
      await pool.ready;
      const tasks = [pool.submitTask([1, 2], undefined, undefined, () => {
        throw new Error('dispatch observer failed');
      }), ...Array.from({length: 3}, () => pool.submitTask([2, 3]))];
      const results = await Promise.allSettled(tasks);
      expect(results[0]).toMatchObject({status: 'rejected', reason: {message: 'dispatch observer failed'}});
      expect(results.slice(1)).toEqual(Array.from({length: 3}, () =>
        expect.objectContaining({status: 'fulfilled', value: expect.objectContaining({body: 5})})));
      expect((await pool.submitTask([3, 4])).body).toBe(7);
    } finally { await pool.dispose(); }
  });

  test('pool would work correctly', async () => {
    const cases: number[][] = [];
    for (let i = 0; i < 100; i++) {
      cases.push([(i * 7919) % 65536, (i * 104729) % 65536]);
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
      await expect(pool.ready).rejects.toThrow('Test worker error');
      expect(fn).toHaveBeenCalled();
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
        expect(pool.workingTasks.size).toBe(0);
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
      expect(pool.workingTasks.size).toBe(0);
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
      expect(pool.workingTasks.size).toBe(0);
      expect(pool.workers[0].load).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool rejects task and log payloads on parentPort', async () => {
    const fn = jest.fn();

    class Pool extends WorkerPool {
      onControlMessage(info: WorkerInfo, message: never) {
        super.onControlMessage(info, message);
        fn(message);
      }
    }

    const pool = new Pool(1,
      join(__dirname, 'invalid-parent-port-worker.js'), {});
    try {
      await pool.ready;
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool ignores malformed task port messages', async () => {
    const fn = jest.fn();

    class Pool extends WorkerPool {
      complete(info: WorkerInfo, message: never) {
        super.complete(info, message);
        fn(message);
      }
    }

    const pool = new Pool(1,
      join(__dirname, 'invalid-task-port-worker.js'), {});
    try {
      await pool.ready;
      const result = await pool.submitTask([2, 3]);
      expect(result.body).toBe(5);
      expect(pool.workers[0].load).toBe(0);
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('pool drains worker logs before dispose resolves', async () => {
    const logs: unknown[][] = [];
    setLogger({
      ...createDefaultLogger(),
      info(_type, ...contents) {
        logs.push(contents);
      }
    });
    const pool = new WorkerPool(1,
      join(__dirname, 'log-after-complete-worker.js'), {});
    try {
      await pool.ready;
      const result = await pool.submitTask([4, 5]);
      expect(result.body).toBe(9);
      await pool.dispose();
      expect(logs.length).toBe(100);
    } finally {
      setLogger(createDefaultLogger());
    }
  }, 10000);

  test('completion belongs to its assigned worker and settles only once', async () => {
    const pool = new WorkerPool(2,
      join(__dirname, 'delay-calc-worker.js'), {}, 1);
    try {
      await pool.ready;
      const first = pool.submitTask([2, 3]);
      const second = pool.submitTask([4, 5]);
      pool.nextTask();
      const owner = pool.workers[0];
      const other = pool.workers[1];
      const forged = {version: 1 as const, taskId: 1, type: 1, body: 'wrong worker'};
      pool.complete(other, forged);
      expect(pool.workingTasks.size).toBe(2);
      expect(pool.workers.map(worker => worker.load)).toEqual([1, 1]);
      expect((await first).body).toBe(5);
      pool.complete(owner, forged);
      expect(owner.load).toBe(0);
      expect((await second).body).toBe(9);
      expect(pool.workingTasks.size).toBe(0);
      expect(pool.workers.map(worker => worker.load)).toEqual([0, 0]);
    } finally {
      await pool.dispose();
    }
  }, 10000);

  test('tasks wait for initialized readiness', async () => {
    const pool = new WorkerPool(1,
      join(__dirname, 'startup-worker.js'), {mode: 'wait'});
    try {
      const task = pool.submitTask(42);
      pool.nextTask();
      expect(pool.workingTasks.size).toBe(0);
      expect(pool.pendingTasks).toHaveLength(1);
      pool.workers[0].worker.postMessage('initialize');
      await pool.ready;
      expect((await task).body).toBe(42);
    } finally {
      await pool.dispose();
    }
  });

  test.each(['failed', 'exit', 'timeout'])(
    'initialization %s rejects readiness and queued work', async mode => {
      const pool = new WorkerPool(1,
        join(__dirname, 'startup-worker.js'), {mode}, -1, undefined,
        {startupTimeout: mode === 'timeout' ? 100 : 5000});
      const queued = pool.submitTask(42);
      const results = await Promise.allSettled([pool.ready, queued]);
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      const expected = mode === 'failed' ? 'configuration failed' :
        mode === 'exit' ? 'exited with code 0' : 'initialization timed out';
      await expect(pool.ready).rejects.toThrow(expected);
      await pool.dispose();
      expect(pool.workers[0].worker.threadId).toBe(-1);
      expect(pool.pendingTasks).toHaveLength(0);
      expect(pool.workingTasks.size).toBe(0);
    });

  test('partial factory failure terminates already created workers', async () => {
    let count = 0;
    const pool = new WorkerPool(2,
      join(__dirname, 'startup-worker.js'), {mode: 'wait'}, -1,
      (filename, options) => {
        if (count++) throw new Error('factory failed');
        return new Worker(filename, options);
      });
    await expect(pool.ready).rejects.toThrow('factory failed');
    expect(pool.workers).toHaveLength(1);
    expect(pool.workers[0].worker.threadId).toBe(-1);
    await pool.dispose();
  });

  test('disposal during initialization settles readiness', async () => {
    const pool = new WorkerPool(1,
      join(__dirname, 'startup-worker.js'), {mode: 'wait'});
    const rejected = expect(pool.ready).rejects.toThrow('disposed');
    await pool.dispose();
    await rejected;
  });

  test('malformed logs and throwing loggers cannot interrupt task delivery', async () => {
    const info = jest.fn<Logger['info']>(() => { throw new Error('consumer logger failed'); });
    const isTraceEnabled = jest.fn(() => false);
    setLogger({...createDefaultLogger(), info, isTraceEnabled});
    const pool = new WorkerPool(1,
      join(__dirname, 'delay-calc-worker.js'), {});
    try {
      await pool.ready;
      const worker = pool.workers[0];
      const send = (type: number, level: string, content: unknown) =>
        pool.takeLog(worker, {version: 1, type, body: {
          level, content, logType: 'custom.test'
        }} as never);
      for (const level of ['__proto__', 'constructor', 'isTraceEnabled', 'missing']) {
        expect(() => send(0, level, [])).not.toThrow();
      }
      expect(() => send(1, 'info', [])).not.toThrow();
      expect(() => send(0, 'info', 'not an array')).not.toThrow();
      expect(info).not.toHaveBeenCalled();
      expect(isTraceEnabled).not.toHaveBeenCalled();
      expect(() => send(0, 'info', ['valid message'])).not.toThrow();
      expect(info).toHaveBeenCalledWith('custom.test', worker.id, 'valid message');
      expect((await pool.submitTask([5, 6])).body).toBe(11);
    } finally {
      await pool.dispose();
      setLogger(createDefaultLogger());
    }
  }, 10000);

  test('deadline retires a stalled worker and settles its active and queued tasks', async () => {
    const pool = new WorkerPool(1,
      join(__dirname, 'task-deadline-worker.js'), {hang: true}, 2, undefined,
      {taskTimeout: 100});
    try {
      await pool.ready;
      const results = await Promise.allSettled([1, 2, 3].map(value => pool.submitTask(value)));
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason.message).toContain('timed out');
      }
      expect(pool.workingTasks.size).toBe(0);
      expect(pool.pendingTasks).toHaveLength(0);
      expect(pool.workers[0].load).toBe(0);
      await expect(pool.submitTask(4)).rejects.toThrow('timed out');
    } finally {
      await pool.dispose();
    }
    expect(pool.workers[0].worker.threadId).toBe(-1);
  });

  test('a timeout does not replay work or disable surviving workers', async () => {
    let count = 0;
    const pool = new WorkerPool(2,
      join(__dirname, 'task-deadline-worker.js'), {}, 1,
      (filename, options) => new Worker(filename, {
        ...options, workerData: {...options?.workerData, hang: count++ === 0}
      }), {taskTimeout: 1000});
    try {
      await pool.ready;
      const results = await Promise.allSettled([1, 2, 3].map(value => pool.submitTask(value)));
      expect(results[0]).toMatchObject({status: 'rejected'});
      expect(results[1]).toMatchObject({status: 'fulfilled', value: {body: 2}});
      expect(results[2]).toMatchObject({status: 'fulfilled', value: {body: 3}});
      expect((await pool.submitTask(4)).body).toBe(4);
    } finally {
      await pool.dispose();
    }
  });

  test.each(['worker', 'taskPort', 'logPort'] as const)(
    'decoding failure on %s rejects assigned work and cleans up', async channel => {
      const pool = new WorkerPool(1,
        join(__dirname, 'task-deadline-worker.js'), {hang: true});
      try {
        await pool.ready;
        const task = pool.submitTask(1);
        const rejected = expect(task).rejects.toThrow('message decoding failed');
        pool.nextTask();
        // Node decoding failures are runtime-dependent; inject the documented event.
        pool.workers[0][channel].emit('messageerror', new Error('decode failed'));
        await rejected;
        expect(pool.workingTasks.size).toBe(0);
        await expect(pool.submitTask(2)).rejects.toThrow('message decoding failed');
      } finally {
        await pool.dispose();
      }
      expect(pool.workers[0].worker.threadId).toBe(-1);
    });

  test('invalid deadlines fail before creating any workers', () => {
    const factory = jest.fn(() => { throw new Error('must not spawn'); });
    for (const key of ['startupTimeout', 'taskTimeout', 'shutdownTimeout']) {
      for (const value of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
        expect(() => new WorkerPool(1, '', {}, -1, factory, {[key]: value}))
          .toThrow(RangeError);
      }
    }
    expect(factory).not.toHaveBeenCalled();
  });

  test('disposal clears active task deadlines and worker load', async () => {
    const pool = new WorkerPool(1,
      join(__dirname, 'task-deadline-worker.js'), {hang: true}, 1, undefined,
      {taskTimeout: 100});
    await pool.ready;
    const task = pool.submitTask(1);
    const rejected = expect(task).rejects.toThrow('disposed');
    pool.nextTask();
    expect(pool.workers[0].load).toBe(1);
    await pool.dispose();
    await rejected;
    expect(pool.workers[0].load).toBe(0);
    // A leaked timer would replace the disposal reason with a timeout.
    await new Promise(resolve => setTimeout(resolve, 150));
    await expect(pool.submitTask(2)).rejects.toThrow('disposed');
  });

  test.each([undefined, 0, 2, '1'])(
    'ignores obsolete startup version %s', async protocolVersion => {
      const pool = new WorkerPool(1,
        join(__dirname, 'task-deadline-worker.js'), {protocolVersion});
      try {
        await pool.ready;
        await expect(pool.submitTask(42)).resolves.toMatchObject({body: 42});
      } finally { await pool.dispose(); }
    });

  test('sends and accepts task messages without a protocol version', async () => {
    const pool = new WorkerPool(1,
      join(__dirname, 'task-deadline-worker.js'), {hang: true});
    try {
      await pool.ready;
      const worker = pool.workers[0];
      const send = jest.spyOn(worker.taskPort, 'postMessage');
      const pending = pool.submitTask(1);
      pool.nextTask();
      expect(send.mock.calls[0][0]).not.toHaveProperty('version');
      pool.complete(worker, {type: 1, taskId: 1, body: 42});
      await expect(pending).resolves.toMatchObject({body: 42});
    } finally { await pool.dispose(); }
  });
});
