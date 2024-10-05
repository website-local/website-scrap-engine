import type {MessagePort, WorkerOptions} from 'worker_threads';
import {Worker} from 'worker_threads';
import type {URL} from 'url';
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
    workerScript: string,
    workerData: Record<string, unknown>,
    public maxLoad: number = -1,
    factory: WorkerFactory = defaultWorkerFactory
  ) {
    const ready: Promise<void>[] = [];
    for (let i = 0; i < coreSize; i++) {
      this.workers[i] = new WorkerInfoImpl(
        factory(workerScript, {workerData}));
      this.workers[i].worker.addListener('message',
        msg => this.onMessage(this.workers[i], msg));
      this.workers[i].worker.addListener('error',
        err => this.workerOnError(this.workers[i], err));
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
    }
    this.takeLog(info, message as LogWorkerMessage);
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
    // hopefully there would not be too many workers
    const sorted = this.workers.sort(
      (a, b) => a.load - b.load);
    for (let i = 0, l = sorted.length, ll = l - 1, n, curr; i < l; i++) {
      curr = sorted[i];
      n = i + 1;
      while (
        (this.maxLoad <= 0 || curr.load < this.maxLoad) &&
        (i == ll || curr.load <= sorted[n].load)
      ) {
        const task: PendingPromiseWithBody<R> | undefined =
          this.pendingTasks.shift();
        if (!task) {
          break;
        }
        try {
          curr.worker.postMessage({
            taskId: task.taskId,
            body: task.body
          }, task.transferList);
          this.workingTasks[task.taskId] = task as PendingPromise;
        } catch (e) {
          delete this.workingTasks[task.taskId];
          task.reject(e);
          continue;
        }
        ++sorted[i].load;
      }
      if (!this.pendingTasks.length) {
        break;
      }
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
