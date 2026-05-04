import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;

const sleep = ms => new Promise(r => setTimeout(r, ms | 0));

parentPort.postMessage({type: 'ready'});

taskPort.addListener('message', async (msg) => {
  const result = msg.body[0] + msg.body[1];
  await sleep(300);
  const message = {
    taskId: msg.taskId,
    type: 1,
    body: result,
    error: isNaN(result) ? new Error('NaN') : undefined
  };
  taskPort.postMessage(message);
  logPort.postMessage({
    // this simulates an invalid log
    type: 0
  });
  logPort.postMessage({
    // this simulates an log with empty body
    type: 0,
    body: {
    }
  });
  logPort.postMessage({
    // this simulates a log with logType only
    type: 0,
    body: {
      logType: 'system.complete'
    }
  });
  logPort.postMessage({
    // this simulates a log without content
    type: 0,
    body: {
      logType: 'system.complete',
      level: 'info'
    }
  });
  logPort.postMessage({
    // this simulates a log with content
    type: 0,
    body: {
      logType: 'system.complete',
      level: 'info',
      content: ['aaa']
    }
  });
});
