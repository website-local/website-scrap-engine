import type {MessagePort, Worker} from 'node:worker_threads';
import {createFilePublication, noFollowWriteFlags} from '../output-store.js';
import type {FilePublication, PublicationStore} from '../output-store.js';
import {withCrawlContext} from '../crawl-context.js';
import type {CrawlContext} from '../crawl-context.js';
import type {BufferAccount} from '../buffer-budget.js';

type Operation = 'create' | 'publish' | 'release' | 'buffer-body' | 'buffer-child';
interface Request {
  requestId: number;
  taskId: number;
  operation: Operation;
  destination?: string;
  localRoot?: string;
  writerRejectsSymlinks?: boolean;
  token?: number;
  bytes?: number;
}
interface Reply {
  requestId: number;
  ok: boolean;
  value?: {token: number; stagingPath: string; direct?: boolean};
  error?: {message: string; code?: string; limit?: number; actual?: number};
}
interface Connection {
  worker: Worker;
  id: number;
  port: MessagePort;
  exited: Promise<void>;
  alive: boolean;
  lastRequest: number;
}
interface Lease {
  context: CrawlContext;
  controller: AbortController;
  connection?: Connection;
  handles: Map<number, FilePublication>;
  operations: Set<Promise<unknown>>;
  closing?: Promise<void>;
}

/** Parent owns allocations and publication even when the writer's thread dies. */
export class WorkerPublicationCoordinator {
  private readonly leases = new Map<number, Lease>();
  private readonly connections = new Set<Connection>();
  private nextToken = 0;

  constructor(private readonly ownsTask: (workerId: number, taskId: number) => boolean,
    private readonly channelFailed: (worker: Worker, error: Error) => void) {}

  attach(worker: Worker, port: MessagePort): void {
    const connection: Connection = {worker, id: worker.threadId, port, alive: true,
      lastRequest: 0, exited: new Promise(resolve => worker.once('exit', () => resolve()))};
    this.connections.add(connection);
    worker.once('exit', () => {
      connection.alive = false;
      this.connections.delete(connection);
      port.close();
    });
    port.on('message', message => this.receive(connection, message));
    const failed = () => {
      if (connection.alive && [...this.leases.keys()].some(id => this.ownsTask(connection.id, id))) {
        this.channelFailed(worker, new Error('Worker publication channel closed'));
      }
      port.close();
    };
    port.on('messageerror', failed);
    port.on('close', failed);
  }

  register(taskId: number, context: CrawlContext): void {
    if (this.leases.has(taskId)) throw new Error('Duplicate publication task');
    this.leases.set(taskId, {context, controller: new AbortController(),
      handles: new Map(), operations: new Set()});
  }

  assign(taskId: number, worker: Worker): void {
    const lease = this.leases.get(taskId);
    const connection = [...this.connections].find(connection => connection.worker === worker);
    if (!lease || !connection) throw new Error('Publication task dispatch has no registered worker');
    lease.connection = connection;
  }

  finish(taskId: number, failed: boolean): Promise<void> {
    const lease = this.leases.get(taskId);
    if (!lease) return Promise.resolve();
    lease.closing ??= (async () => {
      lease.controller.abort(new Error('Publication task closed'));
      // The writer must be stopped before removing paths it may still be using.
      if (failed && lease.connection) await lease.connection.exited;
      await Promise.allSettled(lease.operations);
      const results = await Promise.allSettled([...lease.handles.values()].map(handle => handle.cleanup()));
      lease.handles.clear();
      this.leases.delete(taskId);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Worker staging cleanup failed');
    })();
    return lease.closing;
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.leases.keys()].map(id => this.finish(id, true)));
    for (const connection of this.connections) connection.port.close();
    this.connections.clear();
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Publication coordinator cleanup failed');
  }

  private receive(connection: Connection, request: Request): void {
    if (!request || !Number.isSafeInteger(request.requestId) || request.requestId <= connection.lastRequest ||
      !Number.isSafeInteger(request.taskId) || request.taskId < 1) {
      this.channelFailed(connection.worker, new Error('Invalid worker publication envelope'));
      return;
    }
    connection.lastRequest = request.requestId;
    const lease = this.leases.get(request.taskId);
    const reply = (value?: Reply['value'], error?: unknown) => {
      const details = error as {message?: unknown; code?: unknown; limit?: unknown; actual?: unknown} | undefined;
      try {
        connection.port.postMessage({requestId: request.requestId,
          ok: error === undefined, value, error: error === undefined ? undefined : {
            message: typeof details?.message === 'string' ? details.message : String(error),
            code: typeof details?.code === 'string' ? details.code : undefined,
            limit: typeof details?.limit === 'number' ? details.limit : undefined,
            actual: typeof details?.actual === 'number' ? details.actual : undefined
          }} satisfies Reply);
      } catch (error) { this.channelFailed(connection.worker, error as Error); }
    };
    if (!lease || lease.connection && lease.connection !== connection ||
      request.operation !== 'release' && (lease.closing || !this.ownsTask(connection.id, request.taskId))) {
      reply(undefined, new Error('Publication task is not owned by this worker'));
      return;
    }
    // Release is permitted after cancellation, but never for a foreign worker.
    if (!lease.connection && !this.ownsTask(connection.id, request.taskId)) {
      reply(undefined, new Error('Publication task is no longer active'));
      return;
    }
    lease.connection = connection;
    const operation = withCrawlContext(lease.context, () => this.execute(lease, request));
    lease.operations.add(operation);
    void operation.then(value => reply(value), error => reply(undefined, error))
      .finally(() => lease.operations.delete(operation));
  }

  private async execute(lease: Lease, request: Request): Promise<Reply['value']> {
    if (request.operation === 'buffer-body' || request.operation === 'buffer-child') {
      if (!Number.isSafeInteger(request.bytes) || request.bytes! < 0 || !lease.context.bufferAccount) {
        throw new TypeError('Invalid buffered-byte reservation request');
      }
      if (request.operation === 'buffer-body') await lease.context.bufferAccount.observeBody(request.bytes!);
      else await lease.context.bufferAccount.reserveChild(request.bytes!);
      return;
    }
    if (request.operation === 'create') {
      if (typeof request.destination !== 'string' ||
        request.localRoot !== undefined && typeof request.localRoot !== 'string' ||
        request.writerRejectsSymlinks !== undefined && typeof request.writerRejectsSymlinks !== 'boolean') {
        throw new TypeError('Invalid publication destination');
      }
      const handle = await createFilePublication(request.destination,
        AbortSignal.any([lease.context.signal, lease.controller.signal]), request.localRoot,
        request.writerRejectsSymlinks === true && noFollowWriteFlags !== undefined);
      const token = ++this.nextToken;
      lease.handles.set(token, handle);
      if (lease.controller.signal.aborted) {
        await handle.cleanup();
        lease.handles.delete(token);
        throw new Error('Publication allocation was cancelled');
      }
      return {token, stagingPath: handle.stagingPath, direct: handle.direct};
    }
    const handle = request.token === undefined ? undefined : lease.handles.get(request.token);
    if (!handle) throw new Error('Unknown publication allocation');
    if (request.operation === 'publish') {
      await handle.publish();
      if (handle.direct) {
        await handle.cleanup();
        lease.handles.delete(request.token!);
      }
    }
    else if (request.operation === 'release') {
      await handle.cleanup();
      lease.handles.delete(request.token!);
    } else throw new TypeError('Invalid publication operation');
    return undefined;
  }
}

/** Worker-side proxy. Confirmation is counted by the parent, not a second time here. */
export class WorkerPublicationClient {
  private nextRequest = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: Reply['value']) => void; reject: (error: Error) => void;
  }>();
  constructor(private readonly port: MessagePort) {
    port.on('message', (reply: Reply) => {
      if (!reply || !Number.isSafeInteger(reply.requestId) || typeof reply.ok !== 'boolean') {
        this.close();
        return;
      }
      const pending = this.pending.get(reply.requestId);
      if (!pending) return;
      this.pending.delete(reply.requestId);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(Object.assign(new Error(reply.error?.message ?? 'Publication failed'),
        {code: reply.error?.code, limit: reply.error?.limit, actual: reply.error?.actual}));
    });
    port.on('messageerror', () => this.close());
    port.on('close', () => this.close());
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Publication channel closed'));
    this.pending.clear();
    this.port.close();
  }
  private request(taskId: number, operation: Operation, data: Partial<Request>): Promise<Reply['value']> {
    if (this.closed) return Promise.reject(new Error('Publication channel closed'));
    return new Promise((resolve, reject) => {
      const requestId = ++this.nextRequest;
      this.pending.set(requestId, {resolve, reject});
      try { this.port.postMessage({...data, requestId, taskId, operation}); }
      catch (error) { this.pending.delete(requestId); reject(error); }
    });
  }
  forTask(taskId: number): PublicationStore {
    return {create: async (destination, signal, localRoot, writerRejectsSymlinks = false) => {
      signal?.throwIfAborted();
      const value = await this.request(taskId, 'create', {destination, localRoot, writerRejectsSymlinks});
      if (!value || !Number.isSafeInteger(value.token) || value.token < 1 || typeof value.stagingPath !== 'string' ||
        (value.direct !== undefined && typeof value.direct !== 'boolean')) {
        throw new TypeError('Invalid publication allocation reply');
      }
      let publishing: Promise<void> | undefined;
      let cleaning: Promise<void> | undefined;
      let published = false;
      return {stagingPath: value.stagingPath, direct: value.direct,
        publish: () => {
          if (cleaning) return Promise.reject(new Error('Publication has been closed'));
          publishing ??= (async () => {
            signal?.throwIfAborted();
            await this.request(taskId, 'publish', {token: value.token});
            published = true;
          })();
          return publishing;
        },
        cleanup: () => {
          cleaning ??= (async () => {
            await publishing?.catch(() => undefined);
            if (!value.direct || !published) await this.request(taskId, 'release', {token: value.token});
          })();
          return cleaning;
        }};
    }};
  }

  bufferForTask(taskId: number): BufferAccount {
    let highWater = -1;
    return {
      observeBody: bytes => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid buffered-byte reservation');
        if (bytes <= highWater) return;
        return this.request(taskId, 'buffer-body', {bytes}).then(() => {
          highWater = Math.max(highWater, bytes);
        });
      },
      reserveChild: bytes => {
        if (bytes === 0) return;
        return this.request(taskId, 'buffer-child', {bytes}).then(() => undefined);
      }
    };
  }
}
