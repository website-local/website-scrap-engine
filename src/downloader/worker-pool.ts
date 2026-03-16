import type {MessagePort, WorkerOptions} from 'node:worker_threads';
import {Worker} from 'node:worker_threads';
import type {URL} from 'node:url';
import * as logger from '../logger/logger.js';
import type {LogWorkerMessage} from './worker-type.js';
import type {
  PendingPromise,
  PendingPromiseWithBody,
  WorkerMessage
} from './types.js';
import {WorkerMessageType} from './types.js';

export interface WorkerInfo {
  readonly id: number;
  load: number;
  worker: Worker;
}

export class WorkerInfoImpl implements WorkerInfo {
  readonly id: number;
  load = 0;

  constructor(public worker: Worker) {
    this.id = worker.threadId;
  }
}

export interface WorkerFactory {
  (filename: string | URL, options?: WorkerOptions): Worker;
}

function defaultWorkerFactory(
  filename: string | URL, options?: WorkerOptions): Worker {
  return new Worker(filename, options);
}

export class WorkerPool<T = unknown, R extends WorkerMessage = WorkerMessage> {
  readonly workers: WorkerInfo[] = [];
  readonly pendingTasks: PendingPromiseWithBody<R>[] = [];
  readonly workingTasks: Record<number, PendingPromise> = {};
  readonly ready: Promise<void>;
  taskIdCounter = 0;

  constructor(
    public coreSize: number,
    public workerScript: string,
    public workerData: Record<string, unknown>,
    public maxLoad: number = -1,
    public factory: WorkerFactory = defaultWorkerFactory
  ) {
    const ready: Promise<void>[] = [];
    for (let i = 0; i < coreSize; i++) {
      this.workers[i] = new WorkerInfoImpl(
        factory(workerScript, {workerData}));
      this.workers[i].worker.addListener('message',
        msg => this.onMessage(this.workers[i], msg));
      this.workers[i].worker.addListener('error',
        err => this.workerOnError(this.workers[i], err as Error));
      ready.push(new Promise(resolve =>
        this.workers[i].worker.addListener('online',resolve)));
    }
    this.ready = Promise.all(ready).then(() => undefined);
  }

  workerOnError(info: WorkerInfo, err: Error): void {
    logger.error.error('worker error', info.id, err);
  }

  onMessage(info: WorkerInfo, message: WorkerMessage): void {
    if (message.type === WorkerMessageType.Complete) {
      this.complete(info, message);
    } else {
      this.takeLog(info, message as LogWorkerMessage);
    }
  }

  takeLog(info: WorkerInfo, message: LogWorkerMessage): void {
    if (!message?.body) {
      logger.error.warn('Invalid formatted log', info.id);
      return;
    }
    const content = message?.body?.content;
    if (content?.length) {
      logger?.[message.body.logger]?.[message.body.level]?.(info.id, ...content);
    } else {
      logger?.[message.body.logger]?.[message.body.level]?.(info.id);
    }
  }

  complete(info: WorkerInfo, message: WorkerMessage): void {
    --info.load;
    setImmediate(() => this.nextTask());
    const pending: PendingPromise | undefined = this.workingTasks[message.taskId];
    delete this.workingTasks[message.taskId];
    if (!pending) return;
    pending.resolve(message);
  }

  submitTask(
    taskBody: T,
    transferList?: Array<ArrayBuffer | MessagePort>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const task: PendingPromiseWithBody<R> = {
        taskId: ++this.taskIdCounter,
        resolve,
        reject,
        body: taskBody,
        transferList
      };
      this.pendingTasks.push(task);
      setImmediate(() => this.nextTask());
    });
  }

  nextTask(): void {
    if (!this.pendingTasks.length) {
      return;
    }
    const sorted = this.workers.slice().sort(
      (a, b) => a.load - b.load);
    const n = sorted.length;
    let remaining = this.pendingTasks.length;

    // Cap by maxLoad capacity
    if (this.maxLoad > 0) {
      let capacity = 0;
      for (let i = 0; i < n; i++) {
        capacity += Math.max(0, this.maxLoad - sorted[i].load);
      }
      remaining = Math.min(remaining, capacity);
    }

    if (remaining <= 0) {
      return;
    }

    // Pass 1: water-fill to calculate balanced task assignments
    const assign: number[] = new Array(n).fill(0);
    let level = sorted[0].load;
    for (let i = 0; i < n - 1 && remaining > 0; i++) {
      let gap = sorted[i + 1].load - level;
      if (this.maxLoad > 0) {
        gap = Math.min(gap, this.maxLoad - level);
      }
      if (gap <= 0) continue;
      const width = i + 1;
      const cost = gap * width;
      if (cost <= remaining) {
        for (let j = 0; j <= i; j++) assign[j] += gap;
        remaining -= cost;
        level += gap;
      } else {
        const each = (remaining / width) | 0;
        let extra = remaining % width;
        for (let j = 0; j <= i; j++) {
          assign[j] += each + (extra > 0 ? 1 : 0);
          if (extra > 0) extra--;
        }
        remaining = 0;
      }
    }
    // Distribute remaining evenly across all workers
    if (remaining > 0) {
      const each = (remaining / n) | 0;
      let extra = remaining % n;
      for (let j = 0; j < n; j++) {
        assign[j] += each + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
      }
    }

    // Pass 2: dispatch tasks to workers
    let dispatched = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < assign[i]; j++) {
        const task: PendingPromiseWithBody<R> | undefined =
          this.pendingTasks[dispatched];
        if (!task) break;
        dispatched++;
        try {
          sorted[i].worker.postMessage({
            taskId: task.taskId,
            body: task.body
          }, task.transferList);
          this.workingTasks[task.taskId] = task as PendingPromise;
          ++sorted[i].load;
        } catch (e) {
          delete this.workingTasks[task.taskId];
          task.reject(e);
        }
      }
    }
    if (dispatched > 0) {
      this.pendingTasks.splice(0, dispatched);
    }
  }

  async dispose(): Promise<number[]> {
    const numbers = await Promise.all(
      this.workers.map(info => info.worker.terminate()));
    for (const taskId in this.workingTasks) {
      // noinspection JSUnfilteredForInLoop
      this.workingTasks[taskId].reject(new Error('disposed'));
      // noinspection JSUnfilteredForInLoop
      delete this.workingTasks[taskId];
    }
    return numbers;
  }
}
