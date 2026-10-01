import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;

parentPort.postMessage({version: 1, type: 'ready'});

taskPort.addListener('message', (msg) => {
  taskPort.postMessage({version: 1,
    taskId: msg.taskId,
    type: 1,
    body: msg.body[0] + msg.body[1]
  });
  for (let i = 0; i < 100; i++) {
    logPort.postMessage({version: 1,
      type: 0,
      body: {
        logType: 'system.complete',
        level: 'info',
        content: [i]
      }
    });
  }
});

parentPort.addListener('message', msg => {
  if (msg?.type !== 'close') {
    return;
  }
  taskPort.close();
  logPort.close();
  parentPort.postMessage({version: 1, type: 'closed'});
});
