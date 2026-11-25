/// <reference lib="es2024.arraybuffer" />

import {isMarkedAsUntransferable} from 'node:worker_threads';
import {isArrayBuffer, isNativeError} from 'node:util/types';
import type {DownloadResource} from './types.js';
import type {Resource} from '../resource.js';
import type {StaticDownloadOptions} from '../options.js';
import {safeJoin, writeFile} from '../io.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {disposeHtmlResource} from '../cheerio.js';
import {isPromiseLike} from '../util.js';

/** Saving consumes the body. Partial, shared and protected stores stay intact. */
export function releaseResourceBody(resource: Resource): void {
  const body = resource.body;
  resource.body = undefined;
  if (body === undefined || typeof body === 'string') return;
  const store = ArrayBuffer.isView(body) ? body.buffer : body;
  // Node/V8 upgrades must keep pooled, shared and host-owned stores protected.
  // Recheck save-body-ownership.spec.ts before changing these eligibility tests;
  // detachment affects every view, including ones retained by application hooks.
  if (isArrayBuffer(store) && store.byteLength &&
      (!ArrayBuffer.isView(body) || body.byteLength === store.byteLength) &&
      !isMarkedAsUntransferable(store)) {
    try {
      ArrayBuffer.prototype.transfer.call(store, 0);
    } catch (error) {
      // Host-owned stores, such as WebAssembly memory, cannot be detached.
      if (!isNativeError(error) || error.name !== 'TypeError') throw error;
    }
  }
}

/** Redirect helper resources never enter the downloader. */
export function disposeRedirectResource(
  resource: Resource | undefined,
  owner: Resource,
  other?: Resource
): void | Promise<void> {
  if (!resource || resource.meta === owner.meta || resource.meta === other?.meta) return;
  const document = resource.meta.doc;
  if (document && (document === owner.meta.doc || document === other?.meta.doc)) {
    const pending = resource.meta.statusChanges;
    if (pending?.length) return (async () => {
      for (let index = 0; index < pending.length; index++) await pending[index];
      resource.meta.statusChanges = undefined;
      resource.meta.doc = undefined;
    })();
    resource.meta.doc = undefined;
    return;
  }
  return disposeHtmlResource(resource);
}

export async function saveResourceToDisk(
  res: DownloadResource,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  let failed = false;
  try {
    const localRoot: string = res.localRoot ?? options.localRoot;
    // https://github.com/website-local/website-scrap-engine/issues/174
    let mtime: number | void = void 0;
    if (options.preferRemoteLastModifiedTime && res.meta?.headers?.['last-modified']) {
      mtime = Date.parse(res.meta.headers?.['last-modified']) / 1000;
    }
    if (res.redirectedUrl && res.redirectedUrl !== res.url) {
      if (res.redirectedSavePath) {
        if (res.redirectedSavePath !== res.savePath) {
          const redirectedSavePath = decodeURI(res.redirectedSavePath);
          await writeFile(safeJoin(localRoot, redirectedSavePath), res.body,
            res.encoding, mtime);
        }
        const savePath = decodeURI(res.savePath);
        await writeFile(safeJoin(localRoot, savePath), res.body, res.encoding, mtime);
        return;
      }
      if (await saveRedirectedResource(res, pipeline, localRoot, mtime)) return;
    }
    const filePath: string = safeJoin(localRoot, decodeURI(res.savePath));
    await writeFile(filePath, res.body, res.encoding, mtime);
    return;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const disposal = disposeHtmlResource(res);
    if (isPromiseLike(disposal)) await disposal;
    if (!failed) releaseResourceBody(res);
  }
}

/** Only legacy redirects without a precomputed path create helper resources. */
async function saveRedirectedResource(
  res: DownloadResource,
  pipeline: PipelineExecutor,
  localRoot: string,
  mtime: number | void
): Promise<boolean> {
  let redirectResource: Resource | undefined;
  let redirectedResource: Resource | undefined;
  try {
    redirectResource = await pipeline.createResource(res.type,
      res.depth, res.url, res.redirectedUrl!, localRoot,
      res.encoding, undefined, res.type);
    if (!redirectResource?.replacePath) return false;
    await writeFile(safeJoin(localRoot, decodeURI(res.savePath)), res.body, res.encoding, mtime);
    redirectedResource = await pipeline.createResource(res.type,
      res.depth, res.redirectedUrl!, res.refUrl, res.localRoot,
      res.encoding, undefined, res.type);
    if (redirectedResource) {
      await writeFile(safeJoin(localRoot, decodeURI(redirectedResource.savePath)), res.body, res.encoding, mtime);
    }
    return true;
  } finally {
    try {
      if (redirectedResource) {
        const disposing = disposeRedirectResource(redirectedResource, res, redirectResource);
        if (disposing) await disposing;
      }
    } finally {
      if (redirectResource) {
        const disposing = disposeRedirectResource(redirectResource, res);
        if (disposing) await disposing;
      }
    }
  }
}
