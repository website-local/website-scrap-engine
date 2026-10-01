import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;
parentPort.postMessage({version: 'protocolVersion' in workerData ? workerData.protocolVersion : 1,
  type: 'ready'});
taskPort.on('message', ({version, taskId, body}) => {
  if (version !== 1) throw new Error('Invalid parent task version');
  if (workerData.hang) return;
  taskPort.postMessage({version: 1, taskId, type: 1, body});
});
parentPort.on('message', message => {
  if (message?.type !== 'close') return;
  taskPort.close();
  logPort.close();
  parentPort.postMessage({version: 1, type: 'closed'});
});
