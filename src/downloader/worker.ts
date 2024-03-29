import {parentPort, workerData} from 'worker_threads';
import {
  DownloadOptions,
  mergeOverrideOptions,
  StaticDownloadOptions
} from '../options';
import type {DownloadResource, SubmitResourceFunc} from '../life-cycle/types';
import {
  normalizeResource,
  prepareResourceForClone,
  RawResource,
  Resource
} from '../resource';
import {skip} from '../logger/logger';
import {importDefaultFromPath} from '../util';
import {DownloadWorkerMessage, WorkerMessageType} from './types';
import {PipelineExecutorImpl} from './pipeline-executor-impl';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../life-cycle/pipeline-executor';
import type {WorkerTaskMessage} from './worker-type';

const {pathToOptions, overrideOptions}: {
  pathToOptions: string,
  overrideOptions?: Partial<StaticDownloadOptions>
} = workerData;

const options: DownloadOptions =
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mergeOverrideOptions(importDefaultFromPath(pathToOptions), overrideOptions);

const pipeline: PipelineExecutor =
  new PipelineExecutorImpl(options, options.req, options);

options.configureLogger(options.localRoot, options.logSubDir || '');

const init = pipeline.init(pipeline);

parentPort?.addListener('message', async (msg: WorkerTaskMessage<RawResource>) => {
  const collectedResource: RawResource[] = [];
  let error: Error | unknown | void;
  let redirectedUrl: string | undefined;
  try {
    await init;
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
