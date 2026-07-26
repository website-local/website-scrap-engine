import {describe, expect, test} from '@jest/globals';
import PQueue from 'p-queue';

describe('p-queue compatibility', function () {
  test('supports the API contract used by AbstractDownloader', async () => {
    const queue = new PQueue({concurrency: 2});
    const completed: number[] = [];

    queue.pause();
    const first = queue.add(() => new Promise<void>(resolve => setImmediate(() => {
      completed.push(1);
      resolve();
    })));
    const second = queue.add(() => {
      completed.push(2);
    });

    expect(queue.size).toBe(2);
    expect(queue.pending).toBe(0);

    queue.concurrency = 1;
    expect(queue.concurrency).toBe(1);

    queue.start();
    await Promise.all([first, second]);
    await queue.onIdle();

    expect(completed).toStrictEqual([1, 2]);
    expect(queue.size).toBe(0);
    expect(queue.pending).toBe(0);

    queue.pause();
    let clearedTaskRan = false;
    void queue.add(() => {
      clearedTaskRan = true;
    });
    expect(queue.size).toBe(1);

    queue.clear();
    queue.start();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(clearedTaskRan).toBe(false);
    expect(queue.size).toBe(0);
    expect(queue.pending).toBe(0);
  });
});
