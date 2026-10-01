import type {Resource} from '../resource.js';
import type {SubmitResourceFunc} from '../life-cycle/types.js';
import {checkResourceBody} from '../resource-limits.js';

export class DiscoveryLimitError extends Error {
  readonly code = 'ERR_DISCOVERY_LIMIT';
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`Resource discovery count ${actual} exceeds maxDiscoveredResources ${limit}`);
    this.name = 'DiscoveryLimitError';
  }
}

/** Synchronous admission never waits on a queue that its parent may occupy. */
export function createDiscoverySubmit(
  accept: (resource: Resource) => void, signal: AbortSignal,
  maxDiscoveredResources?: number, maxResourceBytes?: number
): {submit: SubmitResourceFunc; close(): void} {
  let count = 0;
  let closed = false;
  const one = (resource: Resource) => {
    signal.throwIfAborted();
    if (closed) throw new Error('Resource discovery is closed for this parent');
    if (maxDiscoveredResources !== undefined && count >= maxDiscoveredResources) {
      throw new DiscoveryLimitError(maxDiscoveredResources, count + 1);
    }
    ++count;
    checkResourceBody(resource, maxResourceBytes);
    accept(resource);
  };
  return {
    submit: resources => {
      if (Array.isArray(resources)) {
        for (const resource of resources) one(resource);
      } else one(resources);
    },
    close() { closed = true; }
  };
}
