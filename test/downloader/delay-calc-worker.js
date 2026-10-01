import {parentPort, workerData} from 'node:worker_threads';

const {taskPort, logPort} = workerData.workerChannels;

const sleep = ms => new Promise(r => setTimeout(r, ms | 0));

parentPort.postMessage({version: 1, type: 'ready'});

taskPort.addListener('message', async (msg) => {
  const result = msg.body[0] + msg.body[1];
  await sleep(300);
  const message = {version: 1,
    taskId: msg.taskId,
    type: 1,
    body: result,
    error: isNaN(result) ? new Error('NaN') : undefined
  };
  taskPort.postMessage(message);
  logPort.postMessage({version: 1,
    // this simulates an invalid log
    type: 0
  });
  logPort.postMessage({version: 1,
    // this simulates an log with empty body
    type: 0,
    body: {
    }
  });
  logPort.postMessage({version: 1,
    // this simulates a log with logType only
    type: 0,
    body: {
      logType: 'system.complete'
    }
  });
  logPort.postMessage({version: 1,
    // this simulates a log without content
    type: 0,
    body: {
      logType: 'system.complete',
      level: 'info'
    }
  });
  logPort.postMessage({version: 1,
    // this simulates a log with content
    type: 0,
    body: {
      logType: 'system.complete',
      level: 'info',
      content: ['aaa']
    }
  });
});
