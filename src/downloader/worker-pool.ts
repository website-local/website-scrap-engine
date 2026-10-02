import type {MessagePort, Transferable, WorkerOptions} from 'node:worker_threads';
import {MessageChannel, Worker} from 'node:worker_threads';
import type {URL} from 'node:url';
import {error as errorLogger, getLogger} from '../logger/logger.js';
import type {LogWorkerMessage} from './worker-type.js';
import type {
  PendingPromise,
  PendingPromiseWithBody,
  WorkerControlMessage,
  WorkerMessage
} from './types.js';
import {WorkerControlMessageType, WorkerMessageType} from './types.js';
import type {WorkerChannels} from './worker-channel.js';
import {logLevels} from '../logger/logger-worker.js';

export interface WorkerInfo {
  readonly id: number;
  load: number;
  worker: Worker;
  taskPort: MessagePort;
  logPort: MessagePort;
  closed?: Promise<void>;
  resolveClosed?: () => void;
}

export class WorkerInfoImpl implements WorkerInfo {
  readonly id: number;
  load = 0;

  constructor(public worker: Worker,
    public taskPort: MessagePort,
    public logPort: MessagePort) {
    this.id = worker.threadId;
  }
}

export interface WorkerFactory {
  (filename: string | URL, options?: WorkerOptions): Worker;
}

export interface WorkerPoolOptions {
  /** Maximum time for each worker to announce successful initialization. */
  startupTimeout?: number;
  /** Deadline from dispatch to completion; omitted means no task deadline. */
  taskTimeout?: number;
  /** Grace period for worker cancellation/closing. Defaults to 1000ms. */
  shutdownTimeout?: number;
}

function defaultWorkerFactory(
  filename: string | URL, options?: WorkerOptions): Worker {
  return new Worker(filename, options);
}

function validateTimeout(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new RangeError(`${name} must be an integer between 1 and 2147483647`);
  }
  return value;
}

export class WorkerPool<T = unknown, R extends WorkerMessage = WorkerMessage> {
  readonly workers: WorkerInfo[] = [];
  readonly pendingTasks: PendingPromiseWithBody<R>[] = [];
  readonly workingTasks: Map<number, PendingPromise> = new Map();
  readonly ready: Promise<void>;
  taskIdCounter = 0;
  private _isDisposing = false;
  private _disposePromise?: Promise<number[]>;
  private readonly _unavailableWorkers = new Set<WorkerInfo>();
  private _lastWorkerError?: Error;
  private _initialized = false;
  private _nextTaskScheduled = false;
  private readonly _taskTimeout?: number;
  private readonly _shutdownTimeout: number;
  private readonly _taskTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly _terminations = new Map<WorkerInfo, Promise<number>>();
  private readonly _starting = new Map<WorkerInfo, {
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    public coreSize: number,
    public workerScript: string,
    public workerData: Record<string, unknown>,
    public maxLoad: number = -1,
    public factory: WorkerFactory = defaultWorkerFactory,
    options: WorkerPoolOptions = {}
  ) {
    if (!Number.isSafeInteger(coreSize) || coreSize < 1) {
      throw new RangeError('coreSize must be a positive integer');
    }
    const startupTimeout = validateTimeout('startupTimeout', options.startupTimeout ?? 30000);
    this._shutdownTimeout = validateTimeout('shutdownTimeout', options.shutdownTimeout ?? 1000);
    this._taskTimeout = options.taskTimeout === undefined ? undefined :
      validateTimeout('taskTimeout', options.taskTimeout);
    const ready: Promise<void>[] = [];
    for (let i = 0; i < coreSize; i++) {
      const taskChannel = new MessageChannel();
      const logChannel = new MessageChannel();
      const workerChannels: WorkerChannels = {
        taskPort: taskChannel.port2,
        logPort: logChannel.port2
      };
      let worker: Worker;
      try {
        worker = factory(workerScript, {
          workerData: {
            ...workerData,
            workerChannels
          },
          transferList: [taskChannel.port2, logChannel.port2]
        });
      } catch (error) {
        taskChannel.port1.close();
        taskChannel.port2.close();
        logChannel.port1.close();
        logChannel.port2.close();
        ready.push(Promise.reject(error));
        break;
      }
      this.workers[i] = new WorkerInfoImpl(
        worker, taskChannel.port1, logChannel.port1);
      this.workers[i].worker.addListener('message',
        msg => this.onControlMessage(this.workers[i], msg));
      this.workers[i].taskPort.addListener('message',
        msg => this.complete(this.workers[i], msg as WorkerMessage));
      this.workers[i].logPort.addListener('message',
        msg => this.takeLog(this.workers[i], msg as LogWorkerMessage));
      this.workers[i].worker.addListener('error',
        err => this.workerOnError(this.workers[i], err as Error));
      this.workers[i].worker.addListener('exit',
        exitCode => this.workerOnExit(this.workers[i], exitCode));
      const info = this.workers[i];
      for (const channel of [info.worker, info.taskPort, info.logPort]) {
        channel.addListener('messageerror', error => {
          this.rejectWorkerTasks(info, new Error(
            `worker ${info.id} message decoding failed`, {cause: error}));
        });
      }
      ready.push(new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          this._starting.delete(info);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => finish(new Error(
          `worker ${info.id} initialization timed out after ${startupTimeout}ms`
        )), startupTimeout);
        this._starting.set(info, {
          resolve: () => finish(), reject: error => finish(error)
        });
      }));
    }
    this.ready = Promise.all(ready).then(() => {
      if (this._isDisposing) throw new Error('disposed');
      this._initialized = true;
      this.nextTask();
    }).catch(async error => {
      this._lastWorkerError = error;
      await this.dispose();
      throw error;
    });
    // Keep rejection observable through ready without an unhandled-rejection race.
    void this.ready.catch(() => undefined);
  }

  workerOnError(info: WorkerInfo, err: Error): void {
    this.rejectWorkerTasks(info, err);
    try { errorLogger.error('worker error', info.id, err); } catch { /* Consumer logger. */ }
  }

  workerOnExit(info: WorkerInfo, exitCode: number): void {
    if (this._isDisposing) {
      return;
    }
    this.rejectWorkerTasks(info,
      new Error(`worker ${info.id} exited with code ${exitCode}`));
  }

  rejectWorkerTasks(info: WorkerInfo, err: Error): void {
    this._starting.get(info)?.reject(err);
    if (this._unavailableWorkers.has(info)) {
      return;
    }
    this._unavailableWorkers.add(info);
    this._lastWorkerError = err;
    // A worker crash has no Complete message, so reject tasks still assigned to it.
    info.load = 0;
    for (const [taskId, pending] of this.workingTasks) {
      const task = pending as PendingPromiseWithBody<R>;
      if (task.workerId !== info.id) {
        continue;
      }
      this.workingTasks.delete(taskId);
      this.clearTaskTimer(taskId);
      task.reject(err);
    }
    if (!this.workers.some(worker => !this._unavailableWorkers.has(worker))) {
      for (const task of this.pendingTasks) {
        task.reject(err);
      }
      this.pendingTasks.length = 0;
    }
    void this.terminateWorker(info).catch(() => undefined);
    this.scheduleNextTask();
  }

  private clearTaskTimer(taskId: number): void {
    if (this._taskTimeout === undefined) return;
    clearTimeout(this._taskTimers.get(taskId));
    this._taskTimers.delete(taskId);
  }

  private scheduleNextTask(): void {
    if (this._nextTaskScheduled) return;
    this._nextTaskScheduled = true;
    setImmediate(() => {
      // Dispatch callbacks may submit more work for a subsequent turn.
      this._nextTaskScheduled = false;
      this.nextTask();
    });
  }

  private terminateWorker(info: WorkerInfo): Promise<number> {
    let termination = this._terminations.get(info);
    if (!termination) {
      termination = info.worker.terminate().finally(() => {
        info.taskPort.close();
        info.logPort.close();
      });
      this._terminations.set(info, termination);
    }
    return termination;
  }

  onControlMessage(info: WorkerInfo, message: WorkerControlMessage): void {
    if (message?.type === WorkerControlMessageType.Ready) {
      this._starting.get(info)?.resolve();
      return;
    }
    if (message?.type === WorkerControlMessageType.Failed) {
      this.rejectWorkerTasks(info, new Error(message.error || 'Worker initialization failed'));
      return;
    }
    if (message?.type === WorkerControlMessageType.Closed) {
      info.resolveClosed?.();
      return;
    }
    errorLogger.warn('Invalid worker control message', info.id);
  }

  takeLog(info: WorkerInfo, message: LogWorkerMessage): void {
    if (message?.type !== WorkerMessageType.Log || !message.body) {
      errorLogger.warn('Invalid formatted log', info.id);
      return;
    }
    const level = message.body.level;
    const logType = message.body.logType;
    if (!logLevels.includes(level) || typeof logType !== 'string' ||
      (message.body.content !== undefined && !Array.isArray(message.body.content))) {
      return;
    }
    const log = getLogger();
    const content = message.body.content;
    try {
      log[level](logType, info.id, ...(content ?? []));
    } catch {
      // Consumer loggers must not crash message delivery or strand worker tasks.
    }
  }

  complete(info: WorkerInfo, message: WorkerMessage): void {
    if (this._isDisposing) return;
    if (message?.type !== WorkerMessageType.Complete ||
      !Number.isSafeInteger(message.taskId) || message.taskId <= 0) {
      errorLogger.warn('Invalid worker task message', info.id);
      return;
    }
    const pending = this.workingTasks.get(message.taskId) as
      PendingPromiseWithBody<R> | undefined;
    if (!pending) {
      errorLogger.warn('Worker completed unknown task', info.id,
        message.taskId);
      return;
    }
    if (pending.workerId !== info.id || this._unavailableWorkers.has(info)) {
      errorLogger.warn('Worker completed task owned by another worker', info.id,
        message.taskId);
      return;
    }
    --info.load;
    this.scheduleNextTask();
    this.workingTasks.delete(message.taskId);
    this.clearTaskTimer(message.taskId);
    pending.resolve(message as R);
  }

  submitTask(
    taskBody: T,
    transferList?: Transferable[], onAccepted?: (taskId: number) => void,
    onDispatched?: (worker: Worker) => void): Promise<R> {
    if (this._isDisposing) {
      return Promise.reject(this._lastWorkerError || new Error('disposed'));
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
        transferList,
        onDispatched
      };
      onAccepted?.(task.taskId);
      this.pendingTasks.push(task);
      this.scheduleNextTask();
    });
  }

  nextTask(): void {
    if (!this._initialized || this._isDisposing || !this.pendingTasks.length) {
      return;
    }
    const sorted = this.workers
      .filter(worker => !this._unavailableWorkers.has(worker))
      .sort((a, b) => a.load - b.load);
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
          const message = {
            taskId: task.taskId,
            body: task.body
          };
          if (task.transferList) {
            sorted[i].taskPort.postMessage(message, task.transferList);
          } else {
            sorted[i].taskPort.postMessage(message);
          }
          task.workerId = sorted[i].id;
          this.workingTasks.set(task.taskId, task as PendingPromise);
          ++sorted[i].load;
          task.onDispatched?.(sorted[i].worker);
          if (this._taskTimeout !== undefined) {
            const info = sorted[i];
            this._taskTimers.set(task.taskId, setTimeout(() => {
              this.rejectWorkerTasks(info, new Error(
                `worker ${info.id} task ${task.taskId} timed out after ${this._taskTimeout}ms`));
            }, this._taskTimeout));
          }
        } catch (e) {
          if (task.workerId !== undefined) {
            this.rejectWorkerTasks(sorted[i], e instanceof Error ? e : new Error(String(e)));
            break;
          }
          this.workingTasks.delete(task.taskId);
          task.reject(e);
        }
      }
    }
    if (dispatched > 0) {
      this.pendingTasks.splice(0, dispatched);
    }
  }

  dispose(): Promise<number[]> {
    this._disposePromise ??= this.disposeOnce();
    return this._disposePromise;
  }

  private async disposeOnce(): Promise<number[]> {
    this._isDisposing = true;
    for (const startup of this._starting.values()) {
      startup.reject(new Error('disposed'));
    }
    const cancel = !this._initialized || this.workingTasks.size > 0;
    this.rejectDisposedTasks();
    const closed = this.workers.map(info => {
      if (this._terminations.has(info) || info.worker.threadId === -1) return;
      return new Promise<void>(resolve => {
        let taskClosed = false;
        let logClosed = false;
        let acknowledged = false;
        const finish = () => {
          clearTimeout(timeout);
          info.taskPort.removeListener('close', onTaskClose);
          info.logPort.removeListener('close', onLogClose);
          info.worker.removeListener('exit', finish);
          info.resolveClosed = undefined;
          resolve();
        };
        const check = () => { if (taskClosed && logClosed && acknowledged) finish(); };
        const onTaskClose = () => { taskClosed = true; check(); };
        const onLogClose = () => { logClosed = true; check(); };
        const timeout = setTimeout(finish, this._shutdownTimeout);
        info.resolveClosed = () => { acknowledged = true; check(); };
        info.taskPort.once('close', onTaskClose);
        info.logPort.once('close', onLogClose);
        info.worker.once('exit', finish);
        info.worker.postMessage({type: cancel ? WorkerControlMessageType.Cancel : WorkerControlMessageType.Close});
      });
    });
    await Promise.all(closed);
    return this.terminateWorkers();
  }

  private rejectDisposedTasks(): void {
    for (const taskId of this._taskTimers.keys()) this.clearTaskTimer(taskId);
    for (const task of this.pendingTasks) {
      task.reject(new Error('disposed'));
    }
    this.pendingTasks.length = 0;
    for (const pending of this.workingTasks.values()) {
      pending.reject(new Error('disposed'));
    }
    this.workingTasks.clear();
    for (const info of this.workers) info.load = 0;
  }

  private async terminateWorkers(): Promise<number[]> {
    this.rejectDisposedTasks();
    return Promise.all(this.workers.map(info => this.terminateWorker(info)));
  }
}
