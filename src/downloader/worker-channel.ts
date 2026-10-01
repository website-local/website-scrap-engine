import type {MessagePort} from 'node:worker_threads';
import {workerData} from 'node:worker_threads';

export interface WorkerChannels {
  taskPort: MessagePort;
  logPort: MessagePort;
}

export function getWorkerChannels(): WorkerChannels {
  const channels = (workerData as {workerChannels?: Partial<WorkerChannels>})
    .workerChannels;
  if (!channels?.taskPort || !channels.logPort) {
    throw new TypeError('workerData.workerChannels is required');
  }
  return channels as WorkerChannels;
}
