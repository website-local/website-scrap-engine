// eslint-disable-next-line @typescript-eslint/no-var-requires
const {parentPort} = require('worker_threads');
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
    // this simulates an log
    type: 0,
    body: {
    }
  });
  parentPort.postMessage({
    // this simulates an log
    type: 0,
    body: {
      logger: 'complete'
    }
  });
  parentPort.postMessage({
    // this simulates an log
    type: 0,
    body: {
      logger: 'complete',
      level: 'info'
    }
  });
  parentPort.postMessage({
    // this simulates an log
    type: 0,
    body: {
      logger: 'complete',
      level: 'info',
      content: ['aaa']
    }
  });
});
