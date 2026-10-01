import {parentPort, workerData} from 'node:worker_threads';

const {taskPort} = workerData.workerChannels;

parentPort.postMessage({version: 1, type: 'ready'});

taskPort.addListener('message', () => {
  process.exit(workerData.exitCode ?? 1);
});
