import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;
let initialized = false;

if (workerData.mode === 'failed') {
  parentPort.postMessage({type: 'failed', error: 'configuration failed'});
} else if (workerData.mode === 'exit') {
  process.exit(0);
}

parentPort.on('message', message => {
  if (message === 'initialize') {
    initialized = true;
    parentPort.postMessage({type: 'ready'});
  } else if (message?.type === 'close') {
    taskPort.close();
    logPort.close();
    parentPort.postMessage({type: 'closed'});
  }
});

taskPort.on('message', ({taskId, body}) => {
  taskPort.postMessage({taskId, type: 1, body: initialized ? body : 'too early'});
});
