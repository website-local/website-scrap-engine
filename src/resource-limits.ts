import {createReadStream, promises as fs} from 'node:fs';
import {Transform} from 'node:stream';
import type {Resource, ResourceEncoding} from './resource.js';
import type {ResourceBody} from './resource.js';
import {currentCrawlContext} from './crawl-context.js';

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

export function resourceBodyBytes(body: ResourceBody | undefined, encoding: ResourceEncoding): number {
  return body === undefined ? 0 : typeof body === 'string' ? Buffer.byteLength(body, encoding ?? 'utf8') :
    body.byteLength;
}

export function accountBufferedBody(body: ResourceBody | undefined, encoding: ResourceEncoding): void | Promise<void> {
  return currentCrawlContext()?.bufferAccount?.observeBody(resourceBodyBytes(body, encoding));
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
  const account = currentCrawlContext()?.bufferAccount;
  if (limit === undefined && !account) return fs.readFile(source, {encoding, signal});
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(source, {signal,
    highWaterMark: limit === undefined ? 65536 : Math.min(65536, limit + 1)})) {
    size += chunk.length;
    checkResourceSize(size, limit);
    const accounting = account?.observeBody(size);
    if (accounting) await accounting;
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);
  return encoding === null ? body : body.toString(encoding);
}
