import {parentPort} from 'node:worker_threads';

parentPort.postMessage({
  taskId: 1,
  type: 1,
  body: 99
});

parentPort.postMessage({
  taskId: -1,
  type: 0,
  body: {
    logType: 'system.complete',
    level: 'info',
    content: ['invalid parentPort log']
  }
});
