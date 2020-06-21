import URI from 'urijs';
import {escapePath} from './util';
import * as path from 'path';

export enum ResourceType {
  Binary = 1,
  Html,
  Css,
  CssInline,
  SiteMap
}

export type ResourceEncoding = null | BufferEncoding;

export type ResourceBody = Buffer | ArrayBuffer | ArrayBufferView | string;

export interface RawResource {
  /**
   * The type of this resource
   */
  type: ResourceType | number;

  /**
   * Recursive depth from root resource
   */
  depth: number;

  /**
   * Character encoding of the content of this resource.
   *
   * For {@link ResourceType.Binary} type, this property should be null
   */
  encoding: ResourceEncoding;

  /**
   * URL of resource
   *
   * Used in de-duplicating, relative-path resolving.
   * May not be the real url.
   */
  url: string;

  /**
   * The {@link .url} when this object created, should never change.
   */
  readonly rawUrl: string;

  /**
   * The absolute url to download.
   */
  downloadLink: string;

  /**
   * The url of the {@link RawResource} creating this resource.
   *
   * Should also be the referer url
   */
  refUrl: string;

  /**
   * The relative path where this resource should be saved to
   */
  savePath: string;

  /**
   * The absolute path which {@link RawResource.savePath} is relative to
   */
  localRoot: string;

  /**
   * The path should replace the url of the link of
   * the {@link RawResource} creating this resource,
   * making the link work after saved to local disk.
   */
  replacePath: string;

  /**
   * Timestamp of the creation of this object.
   */
  createTimestamp: number;

  /**
   * Timestamp when downloading starts.
   */
  downloadStartTimestamp?: number;
  /**
   * {@link .downloadStartTimestamp} - {@link .createTimestamp}
   */
  waitTime?: number;
  /**
   * Timestamp after downloading finished.
   */
  finishTimestamp?: number;
  /**
   * {@link .finishTimestamp} - {@link .downloadStartTimestamp}
   */
  downloadTime?: number;

  /**
   * Downloaded content, if downloaded
   */
  body?: ResourceBody;

  /**
   * Redirected url after downloaded
   */
  redirectedUrl?: string;

  meta: {
    doc?: CheerioStatic;
    [key: string]: unknown;
  }
}

export interface Resource extends RawResource {
  /**
   * If exists, this should be the {@link URI} instance
   * containing the same content of {@link RawResource.url}
   */
  uri?: URI;

  /**
   * If exists, this should be the {@link URI} instance
   * containing the same content of {@link RawResource.refUrl}
   */
  refUri?: URI;

  /**
   * If exists, this should be the {@link URI} instance
   * containing the same content of {@link RawResource.replacePath}
   */
  replaceUri?: URI;

  /**
   * {@link .uri}.hostname()
   */
  host?: string;
}

export function prepareResourceForClone(res: Resource): RawResource {
  const clone: Partial<RawResource> = {};
  for (const key of Object.keys(res)) {
    const value = Reflect.get(res, key);
    if (typeof value === 'object') {
      if (key === 'meta') {
        const props: Record<string, unknown> = clone[key] = {};
        for (const prop of Object.keys(value)) {
          if (typeof value[prop] !== 'object') {
            props[prop] = value[prop];
          }
        }
      } else if (key === 'body' && (
        typeof value === 'string' ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value) ||
        Buffer.isBuffer(value))) {
        clone[key] = value;
      }
    } else {
      Reflect.set(clone, key, value);
    }
  }
  return clone as RawResource;
}

export function createResource(
  type: ResourceType,
  depth: number,
  url: string,
  refUrl: string,
  localRoot: string,
  encoding?: ResourceEncoding
): Resource {
  const rawUrl: string = url;
  const refUri: URI = URI(refUrl);
  if (url.startsWith('//')) {
    // url with the same protocol
    url = refUri.protocol() + ':' + url;
  } else if (url[0] === '/') {
    // absolute path
    url = refUri.protocol() + '://' + refUri.host() + url;
  }
  let uri: URI = URI(url);
  let replaceUri: URI;
  if (uri.is('relative')) {
    replaceUri = uri.clone();
    uri = uri.absoluteTo(refUri);
    url = uri.toString();
  } else if (uri.host() !== refUri.host()) {
    const crossOrigin = uri.host();
    const crossUri = uri.clone()
      .host(refUri.host())
      .protocol(refUri.protocol());
    crossUri.path(crossOrigin + '/' + crossUri.path());
    replaceUri = crossUri.relativeTo(refUrl = refUri.toString());
    replaceUri.path('../' + replaceUri.path());
  } else {
    replaceUri = uri.relativeTo(refUrl);
  }
  let replacePath: string = replaceUri.toString();
  // empty path...
  if (replacePath) {
    replaceUri.path(replacePath = escapePath(replacePath));
  }
  const host: string = uri.hostname();
  let savePath: string = path.join(localRoot, host, escapePath(uri.path()));
  const downloadLink: string = uri.clone().hash('').toString();

  // make html resource ends with .html
  if (type === ResourceType.Html && !savePath.endsWith('.html')) {
    let appendSuffix: string | void;
    if (savePath.endsWith('/') || savePath.endsWith('\\')) {
      appendSuffix = ('index.html');
    } else if (savePath.endsWith('.htm')) {
      appendSuffix = ('l');
    } else if (replacePath) {
      appendSuffix = ('.html');
    }
    if (appendSuffix) {
      savePath += appendSuffix;
      replaceUri.path(replacePath += appendSuffix);
    }
  }

  return {
    type,
    depth,
    encoding: encoding || (type === ResourceType.Binary ? null : 'utf8'),
    url,
    rawUrl,
    downloadLink,
    refUrl,
    savePath,
    localRoot,
    replacePath,
    createTimestamp: Date.now(),
    body: undefined,
    meta: {},
    uri,
    refUri,
    replaceUri,
    host
  };
}

export function normalizeResource(res: RawResource): Resource {
  const resource = res as RawResource & Partial<Resource>;
  if (!resource.uri) {
    resource.uri = URI(resource.url);
  }
  if (!resource.refUri) {
    resource.refUri = URI(resource.url);
  }
  if (!resource.replaceUri) {
    resource.replaceUri = URI(resource.replacePath);
  }
  if (!resource.host) {
    resource.host = resource.uri?.hostname();
  }
  if (!resource.waitTime && resource.downloadStartTimestamp) {
    resource.waitTime = resource.downloadStartTimestamp - resource.createTimestamp;
  }
  if (!resource.downloadTime &&
    resource.finishTimestamp &&
    resource.downloadStartTimestamp) {
    resource.downloadTime = resource.finishTimestamp - resource.downloadStartTimestamp;
  }
  return resource;
}
