import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;
let initialized = false;

if (workerData.mode === 'failed') {
  parentPort.postMessage({version: 1, type: 'failed', error: 'configuration failed'});
} else if (workerData.mode === 'exit') {
  process.exit(0);
}

parentPort.on('message', message => {
  if (message === 'initialize') {
    initialized = true;
    parentPort.postMessage({version: 1, type: 'ready'});
  } else if (message?.type === 'close') {
    taskPort.close();
    logPort.close();
    parentPort.postMessage({version: 1, type: 'closed'});
  }
});

taskPort.on('message', ({taskId, body}) => {
  taskPort.postMessage({version: 1, taskId, type: 1, body: initialized ? body : 'too early'});
});
