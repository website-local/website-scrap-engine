import {parentPort, workerData} from 'node:worker_threads';

const {taskPort} = workerData.workerChannels;

parentPort.postMessage({type: 'ready'});

taskPort.addListener('message', () => {
  process.exit(1);
});
