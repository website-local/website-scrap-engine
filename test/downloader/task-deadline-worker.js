import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;
parentPort.postMessage({type: 'ready'});
taskPort.on('message', ({taskId, body}) => {
  if (workerData.hang) return;
  taskPort.postMessage({taskId, type: 1, body});
});
parentPort.on('message', message => {
  if (message?.type !== 'close') return;
  taskPort.close();
  logPort.close();
  parentPort.postMessage({type: 'closed'});
});
