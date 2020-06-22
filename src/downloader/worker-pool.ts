import {Worker, MessagePort} from 'worker_threads';

export interface PendingPromise<T = unknown, E = unknown> {
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: E) => void;
}

export interface PendingPromiseWithBody<R = unknown, E = unknown, B = unknown>
  extends PendingPromise<R, E> {
  body: B;
  transferList?: Array<ArrayBuffer | MessagePort>;
}

export enum WorkerMessageType {
  Complete,
  Error
}

export interface WorkerMessage<T = unknown> {
  type: WorkerMessageType;
  body: T | Error;
}

export class WorkerPool<T = unknown, R = unknown> {
  readonly pool: Worker[] = [];
  readonly workingWorker: Set<Worker> = new Set<Worker>();
  readonly working: Map<Worker, PendingPromise> = new Map<Worker, PendingPromise>();
  readonly queued: PendingPromiseWithBody<R>[] = [];

  constructor(
    public coreSize: number,
    workerScript: string,
    workerData: Record<string, unknown>) {
    for (let i = 0; i < coreSize; i++) {
      this.pool[i] = new Worker(workerScript, workerData);
      this.pool[i].addListener('message',
        msg => this.onMessage(this.pool[i], msg));
    }
  }

  onMessage(worker: Worker, message: WorkerMessage): void {
    this.workingWorker.delete(worker);
    setImmediate(() => this.nextTask());
    const pending: PendingPromise | undefined = this.working.get(worker);
    if (!pending) return;
    if (message.type === WorkerMessageType.Complete) {
      pending.resolve(message.body);
    } else {
      pending.reject(message.body);
    }
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
      this.nextTask();
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
        worker.postMessage(task.body, task.transferList);
        this.workingWorker.add(worker);
        if (!this.queued.length) {
          break;
        }
      }
    }
  }
}
