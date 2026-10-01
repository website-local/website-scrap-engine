import {parentPort, workerData} from 'node:worker_threads';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {
  DownloadResource,
  SubmitResourceFunc
} from '../life-cycle/types.js';
import type {WireResource, Resource} from '../resource.js';
import {decodeResourceFromClone, prepareResourceForClone} from '../resource.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloadWorkerMessage} from './types.js';
import {WorkerControlMessageType, WorkerMessageType, WORKER_PROTOCOL_VERSION} from './types.js';
import {PipelineExecutorImpl} from './pipeline-executor-impl.js';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../life-cycle/pipeline-executor.js';
import type {WorkerTaskMessage} from './worker-type.js';
import {getWorkerChannels} from './worker-channel.js';
import {withCrawlContext} from '../crawl-context.js';
import {getLogger} from '../logger/logger.js';

const {pathToOptions, overrideOptions}: {
  pathToOptions: string,
  overrideOptions?: Partial<StaticDownloadOptions>
} = workerData;
const {taskPort, logPort} = getWorkerChannels();
const controller = new AbortController();
const context = {signal: controller.signal, logger: getLogger()};
const active = new Set<Promise<void>>();
let closing = false;

const asyncOptions: Promise<DownloadOptions> = importDefaultFromPath(pathToOptions);

const asyncPipeline = asyncOptions.then(options => withCrawlContext(context, () => {
  options = mergeOverrideOptions(options, overrideOptions);

  const pipeline: PipelineExecutor =
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
  try {
    const pipeline = await asyncPipeline;
    controller.signal.throwIfAborted();
    const res = msg.body;
    const downloadResource: DownloadResource = decodeResourceFromClone(res) as DownloadResource;
    const submit: SubmitResourceFunc = (resources: Resource | Resource[]) => {
      controller.signal.throwIfAborted();
      if (Array.isArray(resources)) {
        for (let i = 0; i < resources.length; i++) {
          collectedResource.push(prepareResourceForClone(resources[i]));
        }
      } else {
        collectedResource.push(prepareResourceForClone(resources));
      }
    };
    const processedResource: DownloadResource | void =
      await pipeline.processAfterDownload(downloadResource, submit);
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
      if (typeof structuredClone === 'function') {
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
    const message: DownloadWorkerMessage = {
      version: WORKER_PROTOCOL_VERSION,
      taskId: msg.taskId,
      type: WorkerMessageType.Complete,
      body: collectedResource,
      error,
      redirectedUrl
    };
    if (!closing) taskPort.postMessage(message);
  }

}

taskPort.addListener('message', (msg: WorkerTaskMessage<WireResource>) => {
  if (closing) return;
  const task = withCrawlContext(context, () => processTask(msg));
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
