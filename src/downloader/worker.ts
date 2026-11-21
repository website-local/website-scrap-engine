import {parentPort, workerData} from 'node:worker_threads';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions, selectDownloadHandlers} from '../options.js';
import type {
  DownloadResource,
  SubmitResourceFunc
} from '../life-cycle/types.js';
import type {Resource, WireResource} from '../resource.js';
import {copyResourceBody, decodeResourceFromClone, prepareResourceForClone} from '../resource.js';
import {disposeHtmlResource} from '../cheerio.js';
import {setLogger} from '../logger/logger.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloadWorkerMessage} from './types.js';
import {WorkerMessageType} from './types.js';
import {completedStatusChange, PipelineExecutorImpl} from './pipeline-executor-impl.js';
import type {WorkerTaskMessage} from './worker-type.js';

const {pathToOptions, overrideOptions, useWorkerLogger}: {
  pathToOptions: string,
  overrideOptions?: Partial<StaticDownloadOptions>,
  useWorkerLogger?: boolean
} = workerData;

const asyncOptions: Promise<DownloadOptions> = importDefaultFromPath(pathToOptions);

const asyncPipeline = asyncOptions.then(options => {
  options = mergeOverrideOptions(options, overrideOptions);
  selectDownloadHandlers(options);
  if (useWorkerLogger && options.createLogger) setLogger(options.createLogger(options));

  const pipeline = new PipelineExecutorImpl(options, options.req, options);

  const init = pipeline.init(pipeline);
  if (init && (init as Promise<void>).then) {
    return init.then(() => pipeline);
  }
  return pipeline;
});
void asyncPipeline.catch(() => undefined);

const noResources: WireResource[] = [];

function cloneError(error: unknown): unknown {
  try {
    return error ? structuredClone(error) : new Error(String(error));
  } catch {
    try { return new Error(String(error)); } catch { return new Error('Worker task failed'); }
  }
}

function disposeResource(resource: Resource, message: DownloadWorkerMessage): void | Promise<void> {
  try {
    const disposing = disposeHtmlResource(resource);
    if (disposing) return disposing.catch(error => { message.error ??= cloneError(error); });
  } catch (error) {
    message.error ??= cloneError(error);
  }
}

parentPort?.addListener('message', async (msg: WorkerTaskMessage<WireResource>) => {
  const message: DownloadWorkerMessage = {
    taskId: msg.taskId,
    type: WorkerMessageType.Complete,
    body: noResources
  };
  let collectedResources: WireResource[] | undefined;
  let discoveredUrls: Set<string> | undefined;
  let submittedOwners: Resource[] | undefined;
  let downloadResource: DownloadResource | void = undefined;
  let processedResource: DownloadResource | void = undefined;
  let savedResource: DownloadResource | void = undefined;
  try {
    const pipeline = await asyncPipeline;
    downloadResource = decodeResourceFromClone(msg.body) as DownloadResource;
    const collect = (resource: Resource) => {
      if (resource.meta.doc || resource.meta.statusChanges?.length) {
        // Ordinary discoveries have no document. Retain only actual owners until
        // processing ends, so submitting the active resource cannot dispose it early.
        (submittedOwners ??= []).push(resource);
      }
      if (resource.shouldBeDiscardedFromDownload) return;
      let url: string | undefined;
      if (resource.body === undefined && resource.depth <= pipeline.options.maxDepth) {
        // Match parent admission without cloning URI objects. Rejected depths
        // and already downloaded bodies keep their original submission order.
        url = resource.uri.toString();
        const fragment = url.indexOf('#');
        if (fragment !== -1) url = url.slice(0, fragment);
        if (pipeline.options.deduplicateStripSearch) {
          const query = url.indexOf('?');
          if (query !== -1) url = url.slice(0, query);
        }
        if (discoveredUrls?.has(url)) return;
      }
      const wire = prepareResourceForClone(resource);
      if (wire.body !== undefined && typeof wire.body !== 'string') {
        wire.body = copyResourceBody(wire.body);
      }
      // A caught preparation failure must allow a corrected resubmission.
      if (url !== undefined) (discoveredUrls ??= new Set<string>()).add(url);
      (collectedResources ??= []).push(wire);
    };
    const submit: SubmitResourceFunc = (resources: Resource | Resource[]) => {
      if (Array.isArray(resources)) {
        for (let i = 0; i < resources.length; i++) collect(resources[i]);
      } else {
        collect(resources);
      }
    };
    processedResource = await pipeline.processAfterDownload(downloadResource, submit);
    if (!processedResource) {
      const notified = pipeline.notifyStatusChange(downloadResource, 'processAfterDownload');
      if (notified !== completedStatusChange) await notified;
    } else {
      savedResource = await pipeline.saveToDisk(processedResource);
      if (savedResource) {
        const notified = pipeline.notifyStatusChange(savedResource, 'saveToDisk');
        if (notified !== completedStatusChange) await notified;
      }
    }
    const result = savedResource || processedResource;
    if (result?.redirectedUrl && result.redirectedUrl !== result.url) {
      message.redirectedUrl = result.redirectedUrl;
    }
  } catch (error) {
    message.error = cloneError(error);
  } finally {
    if (submittedOwners) {
      for (const resource of submittedOwners) {
        if (resource === savedResource || resource === processedResource || resource === downloadResource) continue;
        const disposing = disposeResource(resource, message);
        if (disposing) await disposing;
      }
    }
    if (savedResource && savedResource !== processedResource && savedResource !== downloadResource) {
      const disposing = disposeResource(savedResource, message);
      if (disposing) await disposing;
    }
    if (processedResource && processedResource !== downloadResource) {
      const disposing = disposeResource(processedResource, message);
      if (disposing) await disposing;
    }
    if (downloadResource) {
      const disposing = disposeResource(downloadResource, message);
      if (disposing) await disposing;
    }
    message.body = collectedResources || noResources;
    try {
      parentPort?.postMessage(message);
    } catch (error) {
      // A non-cloneable child still produces a completion for its owning task.
      message.body = noResources;
      message.error = cloneError(error);
      try { parentPort?.postMessage(message); } catch { /* parent has closed */ }
    }
  }

});
