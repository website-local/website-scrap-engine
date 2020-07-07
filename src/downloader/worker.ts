import {parentPort, workerData} from 'worker_threads';
import {
  DownloadOptions,
  mergeOverrideOptions,
  StaticDownloadOptions
} from '../options';
import {DownloadResource, SubmitResourceFunc} from '../life-cycle/types';
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
import {PipelineExecutor} from '../life-cycle/pipeline-executor';

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

parentPort?.addListener('message', async (msg: RawResource) => {
  const collectedResource: RawResource[] = [];
  let error: Error | void;
  try {
    const downloadResource: DownloadResource = normalizeResource(msg) as DownloadResource;
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
  } catch (e) {
    error = e;
  } finally {
    const msg: DownloadWorkerMessage = {
      type: WorkerMessageType.Complete,
      body: collectedResource,
      error,
    };
    parentPort?.postMessage(msg);
  }

});
