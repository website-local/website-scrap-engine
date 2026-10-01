import {MessagePort, workerData} from 'node:worker_threads';

export interface WorkerChannels {
  taskPort: MessagePort;
  logPort: MessagePort;
  publicationPort?: MessagePort;
}

export function getWorkerChannels(): WorkerChannels {
  const channels = (workerData as {workerChannels?: Partial<WorkerChannels>})
    ?.workerChannels;
  if (!(channels?.taskPort instanceof MessagePort) ||
    !(channels.logPort instanceof MessagePort) ||
    channels.taskPort === channels.logPort) {
    throw new TypeError('workerData.workerChannels is required');
  }
  if (channels.publicationPort !== undefined &&
    (!(channels.publicationPort instanceof MessagePort) ||
      channels.publicationPort === channels.taskPort || channels.publicationPort === channels.logPort)) {
    throw new TypeError('Invalid worker publication port');
  }
  return channels as WorkerChannels;
}
