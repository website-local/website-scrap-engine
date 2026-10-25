import {WorkerPublicationClient} from './worker-publication.js';
import {disposeHtmlResource} from '../cheerio.js';
import {checkResourceBody} from '../resource-limits.js';
import {parentPort, workerData} from 'node:worker_threads';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {DownloadResource, SubmitResourceFunc} from '../life-cycle/types.js';
import type {Resource, WireResource} from '../resource.js';
import {decodeResourceFromClone, prepareResourceForClone} from '../resource.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloadWorkerMessage} from './types.js';
import {WorkerControlMessageType, WorkerMessageType} from './types.js';
import {completedStatusChange, PipelineExecutorImpl} from './pipeline-executor-impl.js';
import type {WorkerTaskMessage} from './worker-type.js';
import {getWorkerChannels} from './worker-channel.js';
import {createDefaultLogger} from '../logger/default-logger.js';
import {createWorkerLogger} from '../logger/logger-worker.js';

const {pathToOptions, overrideOptions, workerSafeLogger}: {
  pathToOptions: string,
  workerSafeLogger?: boolean,
  overrideOptions?: Partial<StaticDownloadOptions>
} = workerData;
const {taskPort, logPort, publicationPort} = getWorkerChannels();
const publications = publicationPort ? new WorkerPublicationClient(publicationPort) : undefined;
const controller = new AbortController();
const active = new Set<Promise<void>>();
const results: Record<number, DownloadWorkerMessage> = {};
const emptyChildren: WireResource[] = [];
let closing = false;

const asyncOptions: Promise<DownloadOptions> = importDefaultFromPath(pathToOptions);

const asyncPipeline = asyncOptions.then(async options => {
  options = mergeOverrideOptions(options, overrideOptions);

  const logger = workerSafeLogger ? (options.createLogger ?? createDefaultLogger)(options) : createWorkerLogger(logPort);
  const pipeline =
    new PipelineExecutorImpl(options, options.req, options, controller.signal, logger, publications);

  await pipeline.init(pipeline);
  return pipeline;
});

// Retained once per worker. The explicit parent owns all task-specific data.
function submitToWorker(
  results: Record<number, DownloadWorkerMessage>,
  resources: Parameters<SubmitResourceFunc>[0],
  parent: Resource,
  pipeline: Parameters<SubmitResourceFunc>[2]
): void {
  if (Array.isArray(resources)) {
    for (const resource of resources) submitToWorker(results, resource, parent, pipeline);
    return;
  }
  pipeline.signal?.throwIfAborted();
  const count = parent.discoveredCount;
  if (count === undefined) throw new Error('Resource discovery is closed for this parent');
  parent.discoveredCount = count + 1;
  const limit = pipeline.options.maxDiscoveredResources;
  let notified: Promise<void> | void | undefined;
  try {
    if (limit !== undefined && count >= limit) {
      resources.shouldBeDiscardedFromDownload = true;
      pipeline.logger.warn('system.skip', 'Resource exceeds maxDiscoveredResources', resources.url, count + 1, limit);
    } else if (checkResourceBody(resources, pipeline.options.maxResourceBytes, pipeline.logger)) {
      const wire = prepareResourceForClone(resources);
      const result = results[parent.workerTaskId!];
      const collected = result.body === emptyChildren ? result.body = [] : result.body;
      collected.push(wire);
      return;
    }
    notified = pipeline.notifyStatusChange(resources, 'dispose');
  } finally {
    // The wire owns serialized data; its source document stays in this worker.
    const disposing = notified && notified !== completedStatusChange ?
      notified.finally(() => disposeHtmlResource(resources)) : disposeHtmlResource(resources);
    if (disposing) {
      active.add(disposing);
      void disposing.then(() => active.delete(disposing), () => {
        active.delete(disposing);
        parentPort?.postMessage({type: WorkerControlMessageType.Failed, error: 'Submitted resource cleanup failed'});
      });
    }
  }
}

const submit: SubmitResourceFunc = submitToWorker.bind(undefined, results);

async function processTask(msg: WorkerTaskMessage<WireResource>): Promise<void> {
  if (!msg || !Number.isSafeInteger(msg.taskId) || msg.taskId <= 0) {
    parentPort?.postMessage({type: WorkerControlMessageType.Failed, error: 'Invalid worker task envelope'});
    return;
  }
  let error: unknown;
  let redirectedUrl: string | undefined;
  let resource: DownloadResource | undefined;
  let owned: Resource | undefined;
  const message: DownloadWorkerMessage = {
    taskId: msg.taskId, type: WorkerMessageType.Complete, body: emptyChildren,
    progress: {publishedFiles: 0, skipped: false}
  };
  results[msg.taskId] = message;
  try {
    const pipeline = await asyncPipeline;
    controller.signal.throwIfAborted();
    resource = decodeResourceFromClone(msg.body) as DownloadResource;
    owned = resource;
    resource.workerTaskId = msg.taskId;
    resource.discoveredCount = 0;
    resource.publishedFiles = 0;
    resource.shouldBeDiscardedFromDownload = false;
    const processed = await pipeline.processAfterDownload(resource, submit);
    if (processed) owned = processed;
    if (!processed) {
      await pipeline.notifyStatusChange(resource, 'processAfterDownload');
    } else if (await pipeline.saveToDisk(processed)) {
      await pipeline.notifyStatusChange(processed, 'saveToDisk');
    }
    if (processed?.redirectedUrl && processed.redirectedUrl !== processed.url) {
      redirectedUrl = processed.redirectedUrl;
    }
  } catch (e) {
    // handle if object could not be cloned here
    // https://github.com/website-local/website-scrap-engine/issues/340
    try {
      // should always be
      if (e instanceof Error) {
        const details = e as Error & {code?: unknown; limit?: unknown; actual?: unknown};
        error = {name: e.name, message: e.message, stack: e.stack,
          code: typeof details.code === 'string' ? details.code : undefined,
          limit: typeof details.limit === 'number' ? details.limit : undefined,
          actual: typeof details.actual === 'number' ? details.actual : undefined};
      } else if (e === null || typeof e !== 'object') {
        error = new Error(String(e));
      } else {
        error = structuredClone(e);
      }
    } catch {
      // can not clone, so no need to get the full error here
      if (e && typeof e === 'object') {
        const clone: Record<string, string> = {};
        for (const k in e) {
          clone[k] = String((e as Record<string, unknown>)[k]);
        }
        error = clone;
      } else {
        error = String(e);
      }
    }

  } finally {
    if (owned) owned.discoveredCount = undefined;
    if (resource) {
      resource.discoveredCount = undefined;
    }
    if (owned) {
      const disposing = disposeHtmlResource(owned);
      if (disposing) await disposing;
    }
    message.error = error;
    message.redirectedUrl = redirectedUrl;
    message.progress!.publishedFiles = owned?.publishedFiles ?? 0;
    message.progress!.skipped = owned?.shouldBeDiscardedFromDownload ?? false;
    delete results[msg.taskId];
    if (!closing) taskPort.postMessage(message);
    if (message.body !== emptyChildren) message.body.length = 0;
  }
}

taskPort.addListener('message', (msg: WorkerTaskMessage<WireResource>) => {
  if (closing) return;
  const task = processTask(msg);
  active.add(task);
  void task.then(() => active.delete(task), () => {
    active.delete(task);
    parentPort?.postMessage({type: WorkerControlMessageType.Failed, error: 'Worker task response failed'});
  });
});

parentPort?.addListener('message', msg => {
  if (msg?.type !== WorkerControlMessageType.Close &&
    msg?.type !== WorkerControlMessageType.Cancel) {
    return;
  }
  if (closing) return;
  closing = true;
  if (msg.type === WorkerControlMessageType.Cancel) controller.abort(new Error('Worker disposed'));
  void (async () => {
    try { await asyncPipeline; } catch { /* Failed initialization still closes channels. */ }
    await Promise.allSettled(active);
    publications?.close();
    taskPort.close();
    logPort.close();
    parentPort?.postMessage({type: WorkerControlMessageType.Closed});
  })();
});

void asyncPipeline.then(() => {
  if (closing) return;
  parentPort?.postMessage({type: WorkerControlMessageType.Ready});
}, error => {
  if (closing) return;
  parentPort?.postMessage({
    type: WorkerControlMessageType.Failed,
    error: error instanceof Error ? error.message : String(error)
  });
});
