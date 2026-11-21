import type {MessagePort, WorkerOptions} from 'node:worker_threads';
import {Worker} from 'node:worker_threads';
import type {URL} from 'node:url';
import {error as errorLogger, getLogger} from '../logger/logger.js';
import {logLevels} from '../logger/logger-worker.js';
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
  completedTasks: number;
  worker: Worker;
}

export class WorkerInfoImpl implements WorkerInfo {
  readonly id: number;
  load = 0;
  completedTasks = 0;

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
  private _isDisposing = false;
  private readonly _unavailableWorkers = new Set<WorkerInfo>();
  private _lastWorkerError?: Error;
  private _nextTaskScheduled = false;
  private _disposePromise?: Promise<number[]>;
  private readonly _runNextTask = () => {
    this._nextTaskScheduled = false;
    this.nextTask();
  };

  constructor(
    public coreSize: number,
    public workerScript: string,
    public workerData: Record<string, unknown>,
    public maxLoad: number = -1,
    public factory: WorkerFactory = defaultWorkerFactory
  ) {
    const ready: Promise<void>[] = [];
    try {
      for (let i = 0; i < coreSize; i++) {
        const info = new WorkerInfoImpl(factory(workerScript, {workerData}));
        this.workers.push(info);
        info.worker.on('message', msg => this.onMessage(info, msg));
        info.worker.on('error', err => this.workerOnError(info, err as Error));
        info.worker.on('messageerror', err => this.workerOnError(info, err as Error));
        info.worker.on('exit', exitCode => this.workerOnExit(info, exitCode));
        const online = new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            info.worker.off('online', onOnline);
            info.worker.off('error', onError);
            info.worker.off('messageerror', onError);
            info.worker.off('exit', onExit);
          };
          const onOnline = () => { cleanup(); resolve(); };
          const onError = (error: Error) => { cleanup(); reject(error); };
          const onExit = (code: number) => {
            cleanup();
            reject(new Error(`worker ${info.id} exited before online with code ${code}`));
          };
          info.worker.once('online', onOnline);
          info.worker.once('error', onError);
          info.worker.once('messageerror', onError);
          info.worker.once('exit', onExit);
        });
        // A later factory failure must not orphan earlier startup rejections.
        void online.catch(() => undefined);
        ready.push(online);
      }
    } catch (error) {
      this._isDisposing = true;
      for (const info of this.workers) {
        void info.worker.terminate().catch(() => undefined);
      }
      throw error;
    }
    this.ready = Promise.all(ready).then(() => undefined);
    void this.ready.catch(() => undefined);
  }

  workerOnError(info: WorkerInfo, err: Error): void {
    this.rejectWorkerTasks(info, err);
    try {
      errorLogger.error('worker error', info.id, err);
    } catch {
      // A consumer logger must not strand worker tasks.
    }
  }

  workerOnExit(info: WorkerInfo, exitCode: number): void {
    if (this._isDisposing) {
      return;
    }
    this.rejectWorkerTasks(info,
      new Error(`worker ${info.id} exited with code ${exitCode}`));
  }

  rejectWorkerTasks(info: WorkerInfo, err: Error): void {
    if (this._unavailableWorkers.has(info)) {
      return;
    }
    this._unavailableWorkers.add(info);
    this._lastWorkerError = err;
    // A worker crash has no Complete message, so reject tasks still assigned to it.
    info.load = 0;
    for (const [taskId, pending] of Object.entries(this.workingTasks)) {
      const task = pending as PendingPromiseWithBody<R>;
      if (task.workerId !== info.id) {
        continue;
      }
      delete this.workingTasks[Number(taskId)];
      task.reject(err);
    }
    if (!this.workers.some(worker => !this._unavailableWorkers.has(worker))) {
      for (const task of this.pendingTasks) {
        task.reject(err);
      }
      this.pendingTasks.length = 0;
    }
    this.scheduleNextTask();
  }

  onMessage(info: WorkerInfo, message: WorkerMessage): void {
    if (message?.type === WorkerMessageType.Complete) {
      this.complete(info, message);
    } else if (message?.type === WorkerMessageType.Log) {
      this.takeLog(info, message as LogWorkerMessage);
    }
  }

  takeLog(info: WorkerInfo, message: LogWorkerMessage): void {
    if (!message?.body) return;
    const level = message.body.level;
    const logType = message.body.logType;
    if (!logLevels.includes(level) || typeof logType !== 'string' ||
      (message.body.content !== undefined && !Array.isArray(message.body.content))) {
      return;
    }
    const log = getLogger();
    const content = message.body.content;
    try {
      if (content?.length) {
        log[level](logType, info.id, ...content);
      } else {
        log[level](logType, info.id);
      }
    } catch {
      // Logging is independent of task completion.
    }
  }

  complete(info: WorkerInfo, message: WorkerMessage): void {
    if (this._isDisposing || message?.type !== WorkerMessageType.Complete ||
      !Number.isSafeInteger(message.taskId) || message.taskId <= 0) return;
    const pending = this.workingTasks[message.taskId] as
      PendingPromiseWithBody<R> | undefined;
    if (!pending || pending.workerId !== info.id || this._unavailableWorkers.has(info)) {
      return;
    }
    --info.load;
    ++info.completedTasks;
    this.scheduleNextTask();
    delete this.workingTasks[message.taskId];
    pending.resolve(message as R);
  }

  submitTask(
    taskBody: T,
    transferList?: Array<ArrayBuffer | MessagePort>): Promise<R> {
    if (this._isDisposing) {
      return Promise.reject(new Error('disposed'));
    }
    if (!this.workers.some(worker => !this._unavailableWorkers.has(worker))) {
      return Promise.reject(this._lastWorkerError ||
        new Error('No workers available'));
    }
    return new Promise<R>((resolve, reject) => {
      const task: PendingPromiseWithBody<R> = {
        taskId: ++this.taskIdCounter,
        resolve,
        reject,
        body: taskBody,
        transferList
      };
      this.pendingTasks.push(task);
      this.scheduleNextTask();
    });
  }

  private scheduleNextTask(): void {
    if (this._nextTaskScheduled || this._isDisposing || !this.pendingTasks.length) return;
    this._nextTaskScheduled = true;
    setImmediate(this._runNextTask);
  }

  nextTask(): void {
    if (this._isDisposing || !this.pendingTasks.length) {
      return;
    }
    const sorted = this.workers
      .filter(worker => !this._unavailableWorkers.has(worker))
      .sort((a, b) => a.load - b.load || a.completedTasks - b.completedTasks);
    const n = sorted.length;
    if (!n) {
      return;
    }
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
          task.workerId = sorted[i].id;
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

  dispose(): Promise<number[]> {
    if (this._disposePromise) return this._disposePromise;
    this._isDisposing = true;
    let error: Error | undefined;
    for (const task of this.pendingTasks) {
      task.reject(error ??= new Error('disposed'));
    }
    this.pendingTasks.length = 0;
    for (const [taskId, pending] of Object.entries(this.workingTasks)) {
      pending.reject(error ??= new Error('disposed'));
      delete this.workingTasks[Number(taskId)];
    }
    this._disposePromise = Promise.all(this.workers.map(info => {
      info.load = 0;
      return info.worker.terminate();
    }));
    return this._disposePromise;
  }
}
