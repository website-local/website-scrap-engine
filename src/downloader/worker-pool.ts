import {MessagePort, Worker} from 'worker_threads';
import * as logger from '../logger/logger';
import type {LogWorkerMessage} from './worker-type';
import {
  PendingPromise,
  PendingPromiseWithBody,
  WorkerMessage,
  WorkerMessageType
} from './types';

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

export class WorkerPool<T = unknown, R extends WorkerMessage = WorkerMessage> {
  readonly workers: WorkerInfo[] = [];
  readonly pendingTasks: PendingPromiseWithBody<R>[] = [];
  readonly workingTasks: Record<number, PendingPromise> = {};
  taskIdCounter = 0;

  constructor(
    public coreSize: number,
    workerScript: string,
    workerData: Record<string, unknown>,
    public maxLoad: number = -1
  ) {
    for (let i = 0; i < coreSize; i++) {
      this.workers[i] = new WorkerInfoImpl(
        new Worker(workerScript, {workerData}));
      this.workers[i].worker.addListener('message',
        msg => this.onMessage(this.workers[i], msg));
    }
  }

  onMessage(info: WorkerInfo, message: WorkerMessage): void {
    if (message.type === WorkerMessageType.Complete) {
      this.complete(info, message);
    }
    this.takeLog(info, message as LogWorkerMessage);
  }

  takeLog(info: WorkerInfo, message: LogWorkerMessage): void {
    logger?.[message.body.logger]?.[message.body.level]
      ?.(info.id, ...message?.body?.content);
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
    const numbers = Promise.all(
      this.workers.map(info => info.worker.terminate()));
    for (const taskId in this.workingTasks) {
      // noinspection JSUnfilteredForInLoop
      this.workingTasks[taskId].reject(new Error('disposed'));
    }
    return numbers;
  }
}
