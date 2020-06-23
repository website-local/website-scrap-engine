import {parentPort, workerData} from 'worker_threads';
import {DownloadOptions} from '../options';
import {
  DownloadResource,
  PipelineExecutor,
  SubmitResourceFunc
} from '../pipeline';
import {
  normalizeResource,
  prepareResourceForClone,
  RawResource,
  Resource
} from '../resource';
import {skip} from '../logger';
import {WorkerMessage} from './worker-pool';

export type DownloadWorkerMessage = WorkerMessage<RawResource[]>;

const {pathToOptions}: { pathToOptions: string } = workerData;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const options: DownloadOptions = require(pathToOptions);

const pipeline: PipelineExecutor =
  new PipelineExecutor(options, options.req, options);

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
      body: collectedResource,
      error,
    };
    parentPort?.postMessage(msg);
  }

});
