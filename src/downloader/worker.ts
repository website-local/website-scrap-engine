import {parentPort, workerData} from 'node:worker_threads';
import type {DownloadOptions, StaticDownloadOptions} from '../options.js';
import {mergeOverrideOptions} from '../options.js';
import type {
  DownloadResource,
  SubmitResourceFunc
} from '../life-cycle/types.js';
import type {RawResource, Resource} from '../resource.js';
import {normalizeResource, prepareResourceForClone} from '../resource.js';
import {skip} from '../logger/logger.js';
import {importDefaultFromPath} from '../util.js';
import type {DownloadWorkerMessage} from './types.js';
import {WorkerMessageType} from './types.js';
import {PipelineExecutorImpl} from './pipeline-executor-impl.js';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../life-cycle/pipeline-executor.js';
import type {WorkerTaskMessage} from './worker-type.js';

const {pathToOptions, overrideOptions}: {
  pathToOptions: string,
  overrideOptions?: Partial<StaticDownloadOptions>
} = workerData;

const asyncOptions: Promise<DownloadOptions> = importDefaultFromPath(pathToOptions);

const asyncPipeline = asyncOptions.then(options => {
  options = mergeOverrideOptions(options, overrideOptions);

  const pipeline: PipelineExecutor =
    new PipelineExecutorImpl(options, options.req, options);

  options.configureLogger(options.localRoot, options.logSubDir || '');

  const init = pipeline.init(pipeline);
  if (init && (init as Promise<void>).then) {
    return init.then(() => pipeline);
  }
  return pipeline;
});

parentPort?.addListener('message', async (msg: WorkerTaskMessage<RawResource>) => {
  const collectedResource: RawResource[] = [];
  let error: Error | unknown | void;
  let redirectedUrl: string | undefined;
  try {
    const pipeline = await asyncPipeline;
    const res = msg.body;
    const downloadResource: DownloadResource = normalizeResource(res) as DownloadResource;
    const submit: SubmitResourceFunc = (resources: Resource | Resource[]) => {
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
      skip.warn('skipped downloaded resource',
        downloadResource.url, downloadResource.refUrl);
    } else if (await pipeline.saveToDisk(processedResource)) {
      skip.warn('downloaded resource not saved',
        downloadResource.url, downloadResource.refUrl);
    }

    if (processedResource && processedResource.redirectedUrl &&
      processedResource.redirectedUrl !== processedResource.url) {
      redirectedUrl = processedResource.redirectedUrl;
    }
  } catch (e) {
    // TODO: handle if object could not be cloned here
    error = e;
  } finally {
    const message: DownloadWorkerMessage = {
      taskId: msg.taskId,
      type: WorkerMessageType.Complete,
      body: collectedResource,
      error,
      redirectedUrl
    };
    parentPort?.postMessage(message);
  }

});
