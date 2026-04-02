import {parentPort} from 'node:worker_threads';

const sleep = ms => new Promise(r => setTimeout(r, ms | 0));

parentPort.addListener('message', async (msg) => {
  const result = msg.body[0] + msg.body[1];
  await sleep(300);
  const message = {
    taskId: msg.taskId,
    type: 1,
    body: result,
    error: isNaN(result) ? new Error('NaN') : undefined
  };
  parentPort.postMessage(message);
  parentPort.postMessage({
    // this simulates an invalid log
    type: 0
  });
  parentPort.postMessage({
    // this simulates an log with empty body
    type: 0,
    body: {
    }
  });
  parentPort.postMessage({
    // this simulates a log with logType only
    type: 0,
    body: {
      logType: 'system.complete'
    }
  });
  parentPort.postMessage({
    // this simulates a log without content
    type: 0,
    body: {
      logType: 'system.complete',
      level: 'info'
    }
  });
  parentPort.postMessage({
    // this simulates a log with content
    type: 0,
    body: {
      logType: 'system.complete',
      level: 'info',
      content: ['aaa']
    }
  });
});
