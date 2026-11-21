import {parentPort, threadId} from 'node:worker_threads';

let held;
const complete = msg => parentPort.postMessage({
  taskId: msg.taskId,
  type: 1,
  body: {value: msg.body.value, worker: threadId}
});

parentPort.on('message', msg => {
  if (msg.release) {
    if (held) complete(held);
    held = undefined;
    return;
  }
  if (msg.body.log) {
    parentPort.postMessage({type: 0, body: {
      logType: 'custom.test', level: 'info', content: ['worker log']
    }});
  }
  if (msg.body.hold) held = msg;
  else complete(msg);
});
