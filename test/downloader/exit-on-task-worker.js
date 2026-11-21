import {parentPort, workerData} from 'node:worker_threads';

parentPort.postMessage({type: 'ready'});

parentPort.addListener('message', () => {
  process.exit(workerData.exitCode ?? 1);
});
