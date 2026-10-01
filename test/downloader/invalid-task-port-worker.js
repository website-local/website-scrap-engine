import {parentPort, workerData} from 'node:worker_threads';

const {taskPort} = workerData.workerChannels;

parentPort.postMessage({type: 'ready'});

taskPort.addListener('message', (msg) => {
  taskPort.postMessage({
    taskId: msg.taskId,
    type: 0,
    body: 'invalid task message'
  });

  taskPort.postMessage({
    taskId: msg.taskId + 1,
    type: 1,
    body: 'unknown task'
  });

  taskPort.postMessage({
    taskId: msg.taskId,
    type: 1,
    body: msg.body[0] + msg.body[1]
  });
});
