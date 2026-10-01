import {describe, expect, jest, test} from '@jest/globals';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {setLogger} from '../../src/logger/logger.js';
import {createDefaultLogger} from '../../src/logger/default-logger.js';
// noinspection ES6PreferShortImport
import type {WorkerInfo} from '../../src/downloader/worker-pool.js';
// noinspection ES6PreferShortImport
import {WorkerPool} from '../../src/downloader/worker-pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('worker-pool', function () {
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
    const info = jest.fn(() => { throw new Error('consumer logger failed'); });
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
    'incompatible startup version %s rejects and terminates the worker', async protocolVersion => {
      const pool = new WorkerPool(1,
        join(__dirname, 'task-deadline-worker.js'), {protocolVersion});
      const queued = pool.submitTask(1);
      const settled = await Promise.allSettled([pool.ready, queued]);
      expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected']);
      await expect(pool.ready).rejects.toThrow('protocol version mismatch');
      await pool.dispose();
      expect(pool.workers[0].worker.threadId).toBe(-1);
    });

  test.each(['task', 'log', 'control'])(
    'incompatible %s version rejects active tasks', async channel => {
      const pool = new WorkerPool(1,
        join(__dirname, 'task-deadline-worker.js'), {hang: true});
      try {
        await pool.ready;
        const rejected = expect(pool.submitTask(1)).rejects.toThrow('protocol version mismatch');
        pool.nextTask();
        const worker = pool.workers[0];
        if (channel === 'task') {
          pool.complete(worker, {version: 2, type: 1, taskId: 1, body: 42} as never);
        } else if (channel === 'log') {
          pool.takeLog(worker, {version: 2, type: 0} as never);
        } else {
          pool.onControlMessage(worker, {version: 2, type: 'closed'} as never);
        }
        await rejected;
        expect(pool.workingTasks.size).toBe(0);
      } finally {
        await pool.dispose();
      }
    });
});
