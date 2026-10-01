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
}

function defaultWorkerFactory(
  filename: string | URL, options?: WorkerOptions): Worker {
  return new Worker(filename, options);
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
    const startupTimeout = options.startupTimeout ?? 30000;
    if (!Number.isSafeInteger(startupTimeout) || startupTimeout < 1 ||
      startupTimeout > 2147483647) {
      throw new RangeError('startupTimeout must be an integer between 1 and 2147483647');
    }
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
    errorLogger.error('worker error', info.id, err);
    this.rejectWorkerTasks(info, err);
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
      task.reject(err);
    }
    if (!this.workers.some(worker => !this._unavailableWorkers.has(worker))) {
      for (const task of this.pendingTasks) {
        task.reject(err);
      }
      this.pendingTasks.length = 0;
    }
    setImmediate(() => this.nextTask());
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
    setImmediate(() => this.nextTask());
    this.workingTasks.delete(message.taskId);
    pending.resolve(message as R);
  }

  submitTask(
    taskBody: T,
    transferList?: Transferable[]): Promise<R> {
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
        transferList
      };
      this.pendingTasks.push(task);
      setImmediate(() => this.nextTask());
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
        } catch (e) {
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
    const shouldDrainPorts = this.pendingTasks.length === 0 &&
      this.workingTasks.size === 0;
    if (!shouldDrainPorts) {
      return this.terminateWorkers();
    }
    const closed = this.workers.map(info => {
      const closedPorts = Promise.all([
        new Promise<void>(resolve => {
          info.taskPort.once('close', resolve);
        }),
        new Promise<void>(resolve => {
          info.logPort.once('close', resolve);
        })
      ]);
      info.closed = new Promise(resolve => {
        info.resolveClosed = resolve;
      });
      info.worker.postMessage({type: WorkerControlMessageType.Close});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        Promise.all([info.closed, closedPorts]),
        new Promise(resolve => {
          info.worker.once('exit', resolve);
        }),
        new Promise(resolve => {
          timeout = setTimeout(resolve, 1000);
        })
      ]).finally(() => clearTimeout(timeout));
    });
    await Promise.all(closed);
    return this.terminateWorkers();
  }

  private async terminateWorkers(): Promise<number[]> {
    for (const task of this.pendingTasks) {
      task.reject(new Error('disposed'));
    }
    this.pendingTasks.length = 0;
    for (const pending of this.workingTasks.values()) {
      pending.reject(new Error('disposed'));
    }
    this.workingTasks.clear();
    const numbers = await Promise.all(
      this.workers.map(info => info.worker.terminate()));
    for (const info of this.workers) {
      info.taskPort.close();
      info.logPort.close();
    }
    return numbers;
  }
}
