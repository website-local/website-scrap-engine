import {WorkerPublicationClient} from './worker-publication.js';
import {createDiscoverySubmit} from './discovery.js';
import {resourceBodyBytes} from '../resource-limits.js';
import {parentPort, workerData} from 'node:worker_threads';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {DownloadResource} from '../life-cycle/types.js';
import type {WireResource} from '../resource.js';
import {decodeResourceFromClone, prepareResourceForClone} from '../resource.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloadWorkerMessage} from './types.js';
import {WorkerControlMessageType, WorkerMessageType, WORKER_PROTOCOL_VERSION} from './types.js';
import {PipelineExecutorImpl} from './pipeline-executor-impl.js';
import type {WorkerTaskMessage} from './worker-type.js';
import {getWorkerChannels} from './worker-channel.js';
import {withCrawlContext, createResourceProgress, currentCrawlContext} from '../crawl-context.js';
import {setLogger} from '../logger/logger.js';
import {createWorkerLogger} from '../logger/logger-worker.js';

const {pathToOptions, overrideOptions}: {
  pathToOptions: string,
  overrideOptions?: Partial<StaticDownloadOptions>
} = workerData;
const {taskPort, logPort, publicationPort} = getWorkerChannels();
const publications = publicationPort ? new WorkerPublicationClient(publicationPort) : undefined;
const controller = new AbortController();
const logger = createWorkerLogger();
setLogger(logger);
const context = {signal: controller.signal, logger};
const active = new Set<Promise<void>>();
let closing = false;

const asyncOptions: Promise<DownloadOptions> = importDefaultFromPath(pathToOptions);

const asyncPipeline = asyncOptions.then(options => withCrawlContext(context, () => {
  options = mergeOverrideOptions(options, overrideOptions);

  const pipeline =
    new PipelineExecutorImpl(options, options.req, options, controller.signal);

  const init = pipeline.init(pipeline);
  if (init && (init as Promise<void>).then) {
    return init.then(() => pipeline);
  }
  return pipeline;
}));

async function processTask(msg: WorkerTaskMessage<WireResource>): Promise<void> {
  if (msg?.version !== WORKER_PROTOCOL_VERSION ||
    !Number.isSafeInteger(msg.taskId) || msg.taskId <= 0) {
    parentPort?.postMessage({version: WORKER_PROTOCOL_VERSION,
      type: WorkerControlMessageType.Failed, error: 'Invalid worker task envelope'});
    return;
  }
  const collectedResource: WireResource[] = [];
  let error: Error | unknown | void;
  let redirectedUrl: string | undefined;
  let discovery: ReturnType<typeof createDiscoverySubmit> | undefined;
  try {
    const pipeline = await asyncPipeline;
    if (pipeline.options.maxBufferedBytes !== undefined) {
      if (!publications) throw new Error('Buffered-byte accounting requires the parent publication channel');
      currentCrawlContext()!.bufferAccount = publications.bufferForTask(msg.taskId);
    }
    controller.signal.throwIfAborted();
    const res = msg.body;
    const downloadResource: DownloadResource = decodeResourceFromClone(res) as DownloadResource;
    discovery = createDiscoverySubmit(resource => {
      const wire = prepareResourceForClone(resource);
      const reserved = currentCrawlContext()?.bufferAccount?.reserveChild(resourceBodyBytes(wire.body, wire.encoding));
      if (reserved) return reserved.then(() => { collectedResource.push(wire); });
      collectedResource.push(wire);
    }, controller.signal, pipeline.options.maxDiscoveredResources, pipeline.options.maxResourceBytes);
    const processedResource: DownloadResource | void =
      await pipeline.processAfterDownload(downloadResource, discovery.submit);
    const flushing = discovery.flush();
    if (flushing) await flushing;
    if (!processedResource) {
      await pipeline.notifyStatusChange(downloadResource, 'processAfterDownload');
    } else if (await pipeline.saveToDisk(processedResource)) {
      await pipeline.notifyStatusChange(downloadResource, 'saveToDisk');
    }

    if (processedResource && processedResource.redirectedUrl &&
      processedResource.redirectedUrl !== processedResource.url) {
      redirectedUrl = processedResource.redirectedUrl;
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
      } else if (typeof structuredClone === 'function') {
        error = structuredClone(e);
      } else {
        // this is the old behavior before this
        error = e;
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
    discovery?.close();
    try {
      const flushing = discovery?.flush();
      if (flushing) await flushing;
    } catch (failure) {
      if (!error) {
        const details = failure as Error & {code?: string; limit?: number; actual?: number};
        error = {name: details?.name, message: details?.message ?? String(failure),
          code: details?.code, limit: details?.limit, actual: details?.actual};
      }
    }
    const message: DownloadWorkerMessage = {
      version: WORKER_PROTOCOL_VERSION,
      taskId: msg.taskId,
      type: WorkerMessageType.Complete,
      body: collectedResource,
      error,
      redirectedUrl,
      progress: {
        publishedFiles: currentCrawlContext()?.resourceProgress?.publishedFiles ?? 0,
        skipped: currentCrawlContext()?.resourceProgress?.skipped ?? false
      }
    };
    if (!closing) taskPort.postMessage(message);
  }

}

taskPort.addListener('message', (msg: WorkerTaskMessage<WireResource>) => {
  if (closing) return;
  const task = withCrawlContext({...context, resourceProgress: createResourceProgress(),
    publicationStore: publications?.forTask(msg.taskId)}, () => processTask(msg));
  active.add(task);
  void task.then(() => active.delete(task), () => {
    active.delete(task);
    parentPort?.postMessage({version: WORKER_PROTOCOL_VERSION,
      type: WorkerControlMessageType.Failed, error: 'Worker task response failed'});
  });
});

parentPort?.addListener('message', msg => {
  if (msg?.version !== WORKER_PROTOCOL_VERSION) {
    parentPort?.postMessage({version: WORKER_PROTOCOL_VERSION,
      type: WorkerControlMessageType.Failed, error: 'Worker protocol version mismatch'});
    return;
  }
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
    parentPort?.postMessage({version: WORKER_PROTOCOL_VERSION, type: WorkerControlMessageType.Closed});
  })();
});

void asyncPipeline.then(() => {
  if (closing) return;
  parentPort?.postMessage({version: WORKER_PROTOCOL_VERSION, type: WorkerControlMessageType.Ready});
}, error => {
  if (closing) return;
  parentPort?.postMessage({
    version: WORKER_PROTOCOL_VERSION,
    type: WorkerControlMessageType.Failed,
    error: error instanceof Error ? error.message : String(error)
  });
});
