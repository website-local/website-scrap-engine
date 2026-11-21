import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {Transform} from 'node:stream';
import type {Resource, ResourceBody, ResourceEncoding} from './resource.js';
import type {Logger} from './logger/types.js';

export class ResourceSizeError extends Error {
  readonly code = 'ERR_RESOURCE_SIZE_LIMIT';
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`Resource size ${actual} exceeds maxResourceBytes ${limit}`);
    this.name = 'ResourceSizeError';
  }
}

function validateBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Expected a nonnegative byte count');
}

function discard(size: number, limit: number, resource?: Resource, logger?: Logger): false {
  if (resource) {
    resource.shouldBeDiscardedFromDownload = true;
    resource.meta.resourceSize = size;
    resource.meta.resourceSizeLimit = limit;
    logger?.warn('system.skip', 'Resource exceeds maxResourceBytes', resource.url, size, limit);
  }
  return false;
}

export function checkResourceSize(size: number, limit?: number, resource?: Resource, logger?: Logger): boolean {
  if (limit === undefined) return true;
  validateBytes(limit);
  validateBytes(size);
  return size <= limit || discard(size, limit, resource, logger);
}

export function resourceBodyBytes(body: ResourceBody | undefined, encoding: ResourceEncoding): number {
  if (body === undefined) return 0;
  if (typeof body !== 'string') return body.byteLength;
  // byteLength assumes valid hex/base64 and overcounts inputs with ignored characters.
  if (encoding === 'hex' || encoding === 'base64' || encoding === 'base64url') {
    return Buffer.from(body, encoding).length;
  }
  return Buffer.byteLength(body, encoding ?? 'utf8');
}

export function checkResourceBody(res: Resource, limit?: number, logger?: Logger): boolean {
  return limit === undefined || checkResourceSize(resourceBodyBytes(res.body, res.encoding), limit, res, logger);
}

/** Count incoming bytes including any already acquired resume offset. */
export function limitResourceStream(limit: number, offset = 0, resource?: Resource, logger?: Logger): Transform {
  if (!checkResourceSize(offset, limit, resource, logger)) throw new ResourceSizeError(limit, offset);
  let size = offset;
  return new Transform({transform(chunk: Buffer, _encoding, callback) {
    size += chunk.byteLength;
    if (size > limit) {
      discard(size, limit, resource, logger);
      callback(new ResourceSizeError(limit, size));
    } else {
      callback(null, chunk);
    }
  }});
}

/** Return undefined on overflow. Abort and filesystem errors propagate to the caller. */
export async function readResourceFile(
  source: string, encoding: ResourceEncoding, limit?: number, signal?: AbortSignal, resource?: Resource, logger?: Logger
): Promise<string | Buffer | undefined> {
  if (limit === undefined) return readFile(source, {encoding, signal});
  validateBytes(limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(source, {signal, highWaterMark: Math.min(65536, limit + 1)})) {
    size += chunk.length;
    if (size > limit) {
      discard(size, limit, resource, logger);
      return;
    }
    chunks.push(chunk);
  }
  const only = chunks.length === 1 ? chunks[0] : undefined;
  // Reuse a complete chunk directly. Copy slices out of the stream read buffer.
  const body = only && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength ?
    only : Buffer.concat(chunks, size);
  return encoding === null ? body : body.toString(encoding);
}
