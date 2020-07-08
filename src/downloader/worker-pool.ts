import {MessagePort, Worker} from 'worker_threads';
import * as logger from '../logger/logger';
import {LogWorkerMessage} from './worker-type';
import {
  PendingPromise,
  PendingPromiseWithBody,
  WorkerMessage,
  WorkerMessageType
} from './types';

export class WorkerPool<T = unknown, R extends WorkerMessage = WorkerMessage> {
  readonly pool: Worker[] = [];
  readonly workingWorker: Set<Worker> = new Set<Worker>();
  readonly working: Map<Worker, PendingPromise> = new Map<Worker, PendingPromise>();
  readonly queued: PendingPromiseWithBody<R>[] = [];

  constructor(
    public coreSize: number,
    workerScript: string,
    workerData: Record<string, unknown>) {
    for (let i = 0; i < coreSize; i++) {
      this.pool[i] = new Worker(workerScript, {workerData});
      this.pool[i].addListener('message',
        msg => this.onMessage(this.pool[i], msg));
    }
  }

  onMessage(worker: Worker, message: WorkerMessage): void {
    if (message.type === WorkerMessageType.Complete) {
      this.complete(worker, message);
    }
    this.takeLog(worker, message as LogWorkerMessage);
  }

  takeLog(worker: Worker, message: LogWorkerMessage): void {
    logger?.[message.body.logger]?.[message.body.level]
      ?.(worker.threadId, ...message?.body?.content);
  }

  complete(worker: Worker, message: WorkerMessage): void {
    this.workingWorker.delete(worker);
    setImmediate(() => this.nextTask());
    const pending: PendingPromise | undefined = this.working.get(worker);
    this.working.delete(worker);
    if (!pending) return;
    pending.resolve(message);
  }

  submitTask(
    taskBody: T,
    transferList?: Array<ArrayBuffer | MessagePort>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const task: PendingPromiseWithBody<R> = {
        resolve,
        reject,
        body: taskBody,
        transferList
      };
      this.queued.push(task);
      setImmediate(() => this.nextTask());
    });
  }

  nextTask(): void {
    if (!this.queued.length) {
      return;
    }
    if (this.workingWorker.size === this.pool.length) {
      return;
    }
    for (let i = 0; i < this.pool.length; i++) {
      const worker: Worker = this.pool[i];
      if (!this.workingWorker.has(worker)) {
        const task: PendingPromiseWithBody<R> | undefined = this.queued.shift();
        if (!task) break;
        try {
          worker.postMessage(task.body, task.transferList);
          this.workingWorker.add(worker);
          this.working.set(worker, task as PendingPromise);
        } catch (e) {
          this.workingWorker.delete(worker);
          this.working.delete(worker);
          task.reject(e);
        }
        // ok to cast here
        if (!this.queued.length) {
          break;
        }
      }
    }
  }

  dispose(): Promise<number[]> {
    return Promise.all(this.pool.map(w => w.terminate())).then((numbers: number[]) => {
      this.working.forEach((pending) => {
        pending.reject(new Error('disposed'));
      });
      return numbers;
    });
  }
}
