import URI from 'urijs';
import {escapePath, orderUrlSearch, simpleHashString} from './util';
import * as path from 'path';
import {IncomingHttpHeaders} from 'http';
import {CheerioStatic} from './types';
import {error as log} from './logger/logger';

export enum ResourceType {
  /**
   * Binary resource, not parsed nor processed
   */
  Binary = 1,
  /**
   * Html resource
   */
  Html,
  /**
   * Css resource
   */
  Css,
  /**
   * Inline css resource in html,
   * currently only style blocks and style attributes are processed
   */
  CssInline,
  /**
   * Very limited support of site-maps, urls in it are not replaced.
   */
  SiteMap,
  /**
   * Standalone svg image
   * https://github.com/website-local/website-scrap-engine/issues/3
   */
  Svg,
  /**
   * Large binary, which would be streamed directly to disk,
   * {@link Resource.type} must be explicitly set to this value to use streaming.
   * @see downloadStreamingResource
   * @see https://github.com/website-local/website-scrap-engine/issues/2
   */
  StreamingBinary
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
    /**
     * Parsed html content for {@link .type} === {@link ResourceType.Html}
     * or {@link .type} === {@link ResourceType.Svg}
     * after downloaded and parsed, content may differ from {@link .body}
     */
    doc?: CheerioStatic;
    /**
     * Response headers after download
     */
    headers?: IncomingHttpHeaders;
    /**
     * Other custom meta info for resource
     */
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

  /**
   * True if url of this resource should be replaced and not downloaded
   */
  shouldBeDiscardedFromDownload?: boolean;
}

export function prepareResourceForClone(res: Resource): RawResource {
  const clone: Partial<RawResource> = {};
  for (const key of Object.keys(res)) {
    const value = Reflect.get(res, key);
    if (typeof value === 'object') {
      if (key === 'meta') {
        const props: Record<string, unknown> = clone[key] = {};
        for (const prop of Object.keys(value)) {
          // headers can be cloned safely
          if (prop === 'headers' || typeof value[prop] !== 'object') {
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

/**
 * Create a resource
 * @param type {@link RawResource.type}
 * @param depth {@link RawResource.depth}
 * @param url {@link RawResource.rawUrl}
 * @param refUrl {@link RawResource.refUrl}
 * @param localRoot {@link RawResource.localRoot}
 * @param encoding {@link RawResource.encoding}
 * @param keepSearch keep url search params as file name
 * in {@link Resource.replacePath} and {@link Resource.savePath}
 * @param skipReplacePathError true to skip replacePath processing
 * in case of parser error
 */
export function createResource(
  type: ResourceType,
  depth: number,
  url: string,
  refUrl: string,
  localRoot: string,
  encoding?: ResourceEncoding,
  keepSearch?: boolean,
  skipReplacePathError?: boolean
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
  let replacePathHasError = false;
  try {
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
  } catch (e) {
    if (skipReplacePathError) {
      log.warn('Error processing replacePath, skipping',
        url, refUrl, type, e);
      replaceUri = uri.clone();
      replacePathHasError = true;
    } else {
      log.warn('Error processing replacePath',url, refUrl, type, e);
      throw e;
    }
  }
  let replacePath: string = replaceUri.path();
  // empty path...
  if (replacePath) {
    replaceUri.path(replacePath = escapePath(replacePath));
  }
  const host: string = uri.hostname();
  let savePath: string = path.join(host, escapePath(uri.path()));
  const downloadLink: string = uri.clone().hash('').toString();

  // make html resource ends with .html
  if (!replacePathHasError &&
    type === ResourceType.Html &&
    !savePath.endsWith('.html')) {
    let appendSuffix: string | void;
    if (savePath.endsWith('/') || savePath.endsWith('\\')) {
      appendSuffix = 'index.html';
    } else if (savePath.endsWith('.htm')) {
      appendSuffix = 'l';
    } else {
      appendSuffix = '.html';
    }
    if (appendSuffix) {
      savePath += appendSuffix;
      if (replacePath) {
        replaceUri.path(replacePath += appendSuffix);
      }
    }
  }
  if (!replacePathHasError) {
    let search: string;
    if (keepSearch && (search = uri.search())) {
      if (search.length > 43) {
      // avoid too long search
        search = '_' + simpleHashString(orderUrlSearch(search));
      } else {
      // order it
        search = escapePath(orderUrlSearch(search));
      }
      const ext: string = path.extname(savePath);
      if (ext) {
        savePath = savePath.slice(0, -ext.length) + search + ext;
        replaceUri
          .search('')
          .path(replacePath.slice(0, -ext.length) + search + ext);
      } else {
        savePath += search;
        replaceUri
          .search('')
          .path(replaceUri.path() + search);
      }
    } else {
      url = uri.search('').toString();
    }
  }

  const resource: Resource = {
    type,
    depth,
    encoding: encoding || (type === ResourceType.Binary ? null : 'utf8'),
    url,
    rawUrl,
    downloadLink,
    refUrl,
    savePath,
    localRoot,
    replacePath: replaceUri.toString(),
    createTimestamp: Date.now(),
    body: undefined,
    meta: {},
    uri,
    refUri,
    replaceUri,
    host
  };
  if (replacePathHasError) {
    // urls with parser errors should never be downloaded
    resource.shouldBeDiscardedFromDownload = true;
  }
  return resource;
}

export function normalizeResource(res: RawResource): Resource {
  const resource = res as RawResource & Partial<Resource>;
  if (!resource.uri) {
    resource.uri = URI(resource.url);
  }
  if (!resource.refUri) {
    resource.refUri = URI(resource.refUrl);
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
  if (resource.body instanceof ArrayBuffer || ArrayBuffer.isView(resource.body)) {
    resource.body = Buffer.from(resource.body);
  }
  return resource;
}
