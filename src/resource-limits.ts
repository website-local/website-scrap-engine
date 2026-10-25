import {createReadStream, readFile as readFileCallback} from 'node:fs';
import {promisify} from 'node:util';
import {Transform} from 'node:stream';
import type {Resource, ResourceEncoding} from './resource.js';
import type {ResourceBody} from './resource.js';
import type {Logger} from './logger/types.js';

const readFile = promisify(readFileCallback);

export class ResourceSizeError extends Error {
  readonly code = 'ERR_RESOURCE_SIZE_LIMIT';
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`Resource size ${actual} exceeds maxResourceBytes ${limit}`);
    this.name = 'ResourceSizeError';
  }
}

export function checkResourceSize(size: number, limit?: number, resource?: Resource, logger?: Logger): boolean {
  if (limit === undefined || size <= limit) return true;
  if (resource) {
    resource.shouldBeDiscardedFromDownload = true;
    resource.meta.resourceSize = size;
    resource.meta.resourceSizeLimit = limit;
    logger?.warn('system.skip', 'Resource exceeds maxResourceBytes', resource.url, size, limit);
  }
  return false;
}

export function checkResourceBody(res: Resource, limit?: number, logger?: Logger): boolean {
  if (limit === undefined || res.body === undefined) return true;
  return checkResourceSize(typeof res.body === 'string' ?
    Buffer.byteLength(res.body, res.encoding ?? 'utf8') : res.body.byteLength, limit, res, logger);
}

export function resourceBodyBytes(body: ResourceBody | undefined, encoding: ResourceEncoding): number {
  return body === undefined ? 0 : typeof body === 'string' ? Buffer.byteLength(body, encoding ?? 'utf8') :
    body.byteLength;
}

export function limitResourceStream(limit: number, offset = 0, resource?: Resource, logger?: Logger): Transform {
  let size = offset;
  return new Transform({transform(chunk: Buffer, _encoding, callback) {
    size += chunk.byteLength;
    if (!checkResourceSize(size, limit, resource, logger)) callback(new ResourceSizeError(limit, size));
    else callback(null, chunk);
  }});
}

export async function readResourceFile(
  source: string, encoding: ResourceEncoding, limit?: number, signal?: AbortSignal, resource?: Resource, logger?: Logger
): Promise<string | Buffer | undefined> {
  if (limit === undefined) {
    const options = {encoding, signal};
    return readFile(source, options);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(source, {signal,
    highWaterMark: Math.min(65536, limit + 1)})) {
    size += chunk.length;
    if (!checkResourceSize(size, limit, resource, logger)) return;
    chunks.push(chunk);
  }
  // Reuse an owned single chunk, but compact slices so small files do not retain
  // a full stream read buffer through processing or worker transfer.
  const only = chunks.length === 1 ? chunks[0] : undefined;
  const body = only && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength ?
    only : Buffer.concat(chunks, size);
  return encoding === null ? body : body.toString(encoding);
}
