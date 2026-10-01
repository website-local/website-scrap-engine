import {createReadStream, promises as fs} from 'node:fs';
import {Transform} from 'node:stream';
import type {Resource, ResourceEncoding} from './resource.js';

export class ResourceSizeError extends Error {
  readonly code = 'ERR_RESOURCE_SIZE_LIMIT';
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`Resource size ${actual} exceeds maxResourceBytes ${limit}`);
    this.name = 'ResourceSizeError';
  }
}

export function checkResourceSize(size: number, limit?: number): void {
  if (limit !== undefined && size > limit) throw new ResourceSizeError(limit, size);
}

export function checkResourceBody(res: Resource, limit?: number): void {
  if (limit === undefined || res.body === undefined) return;
  checkResourceSize(typeof res.body === 'string' ?
    Buffer.byteLength(res.body, res.encoding ?? 'utf8') : res.body.byteLength, limit);
}

export function limitResourceStream(limit: number, offset = 0): Transform {
  let size = offset;
  return new Transform({transform(chunk: Buffer, _encoding, callback) {
    size += chunk.byteLength;
    if (size > limit) callback(new ResourceSizeError(limit, size));
    else callback(null, chunk);
  }});
}

export async function readResourceFile(
  source: string, encoding: ResourceEncoding, limit?: number, signal?: AbortSignal
): Promise<string | Buffer> {
  if (limit === undefined) return fs.readFile(source, {encoding, signal});
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(source, {signal,
    highWaterMark: Math.min(65536, limit + 1)})) {
    size += chunk.length;
    checkResourceSize(size, limit);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);
  return encoding === null ? body : body.toString(encoding);
}
