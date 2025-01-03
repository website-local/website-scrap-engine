import URI from 'urijs';
import type {IncomingHttpHeaders} from 'node:http';
import * as path from 'node:path';
import {
  escapePath,
  isUrlHttp,
  orderUrlSearch,
  simpleHashString
} from './util.js';
import type {CheerioStatic} from './types.js';
import {error as log} from './logger/logger.js';

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
   * The relative path where the {@link RawResource}
   * creating this resource should be saved to.
   * This is used to generate the {@link .replacePath}
   * See https://github.com/website-local/website-scrap-engine/issues/139
   */
  refSavePath: string;

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

  /**
   * Redirected {@link .savePath} after downloaded,
   * if this is provided, the saveToDisk life cycle would be affected.
   *
   * https://github.com/website-local/website-scrap-engine/issues/139
   * https://github.com/website-local/website-scrap-engine/issues/157
   * https://github.com/website-local/website-scrap-engine/issues/171
   */
  redirectedSavePath?: string;

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
 * The argument type of {@link createResource}
 */
export interface CreateResourceArgument {
  /**
   * {@link RawResource.type}
   */
  type: ResourceType;
  /**
   * {@link RawResource.depth}
   */
  depth: number;
  /**
   * {@link RawResource.rawUrl}
   */
  url: string;
  /**
   * {@link RawResource.refUrl}
   */
  refUrl: string;
  /**
   * {@link RawResource.refSavePath}
   */
  refSavePath?: string;
  /**
   * The {@link type} of the {@link RawResource} creating this resource.
   */
  refType?: ResourceType;
  /**
   * {@link RawResource.localRoot}
   */
  localRoot: string;

  /**
   * Local source path to download from,
   * if empty or undefined, file:// url would not be accepted
   * https://github.com/website-local/website-scrap-engine/issues/126
   */
  localSrcRoot?: string;

  /**
   * {@link RawResource.encoding}
   */
  encoding?: ResourceEncoding;
  /**
   * keep url search params in file name
   * in {@link Resource.replacePath} and {@link Resource.savePath}
   * See commit c8e270c6421ca8a9d1c519737949ad04c09fcb99
   */
  keepSearch?: boolean;
  /**
   * true to skip replacePath processing
   * in case of parser error
   * https://github.com/website-local/website-scrap-engine/issues/107
   */
  skipReplacePathError?: boolean;
  /**
   * Set this to use a custom implementation of {@link generateSavePath}
   */
  generateSavePathFn?: GenerateSavePathFn | void;
}

/**
 * Generate save path from HTTP/HTTPS absolute uri
 * @param uri the HTTP/HTTPS absolute uri
 * @param isHtml should the savePath endsWith .html
 * @param keepSearch keep url search params in file name
 * @param localSrcRoot local source path to download from
 * @return string must return non-empty string
 */
export function generateSavePath(
  uri: URI,
  isHtml?: boolean,
  keepSearch?: boolean,
  localSrcRoot?: string
): string {
  if (uri.is('relative') && uri.protocol() !== 'file') {
    throw new Error('generateSavePath: uri can not be relative: '
      + uri.toString());
  }

  let savePath: string;
  if (uri.protocol() === 'file') {
    if (!localSrcRoot) {
      throw new Error('generateSavePath: using file protocol without localSrcRoot'
        + uri.toString());
    }
    if (process.platform === 'win32' &&
      localSrcRoot.match(/^[a-z]:\//i)) {
      // windows absolute fix
      savePath = uri.pathname().slice(localSrcRoot.length + 1);
      if (savePath[0] === '/') {
        savePath = savePath.slice(1);
      }
    } else {
      savePath = uri.pathname().slice(localSrcRoot.length);
    }
  } else {
    const host: string = uri.hostname();
    savePath = path.join(host || '', escapePath(uri.path()));
  }

  if (isHtml && !savePath.endsWith('.html')) {
    if (uri.protocol() === 'file' && savePath === '' ||
      savePath.endsWith('/') || savePath.endsWith('\\')) {
      savePath += 'index.html';
    } else if (savePath.endsWith('.htm')) {
      savePath += 'l';
    } else {
      savePath += '.html';
    }
  }

  if (keepSearch) {
    let search = uri.search();
    if (search && search.length > 0) {
      if (search.length > 43) {
        const ordered = orderUrlSearch(search);
        const hashed = simpleHashString(ordered);
        log.debug('search too long, replacing with hash', ordered, hashed);
        // avoid too long search
        search = '_' + hashed;
      } else {
        // order it
        search = escapePath(orderUrlSearch(search));
      }
      const ext: string = path.extname(savePath);
      if (ext) {
        savePath = savePath.slice(0, -ext.length) + search + ext;
      } else {
        savePath += search;
      }
    }
  }
  return savePath;
}

export type GenerateSavePathFn = typeof generateSavePath;

export const urlOfSavePath = (savePath: string): string => {
  if (savePath.includes('\\')) {
    return `file:///${savePath.replace(/\\/g, '/')}`;
  }
  return `file:///${savePath}`;
};

/**
 * Check an absolute uri
 * @param uri {@link RawResource.uri}
 * @param refUri {@link RawResource.refUri}
 * @param skipReplacePathError {@link CreateResourceArgument.skipReplacePathError}
 * @param url {@link CreateResourceArgument.url}
 * @param refUrl {@link CreateResourceArgument.refUrl}
 * @param type {@link CreateResourceArgument.type}
 * @throws Error if {@link skipReplacePathError} === false and check fail
 * @return true if {@link skipReplacePathError} === true and check fail
 */
export function checkAbsoluteUri(
  uri: URI,
  refUri: URI,
  skipReplacePathError: boolean | undefined,
  url: string,
  refUrl: string,
  type: ResourceType
): boolean {
  let replacePathHasError = false;
  const protocol = uri.protocol().toLowerCase();
  if (protocol !== 'http' &&
    protocol !== 'https' &&
    protocol !== 'file' &&
    protocol !== refUri.protocol().toLowerCase()) {
    if (skipReplacePathError) {
      log.warn('protocol not supported, skipping',
        protocol, url, refUrl, type);
      replacePathHasError = true;
    } else {
      log.warn('protocol not supported, skipping',
        protocol, url, refUrl, type);
      throw new Error(`protocol ${protocol} not supported`);
    }
  }
  if (protocol !== 'file' && !uri.host()) {
    if (skipReplacePathError) {
      log.warn('empty host for non-file uri not supported, skipping',
        protocol, url, refUrl, type);
      replacePathHasError = true;
    } else {
      log.warn('empty host for non-file uri not supported, skipping',
        protocol, url, refUrl, type);
      throw new Error('empty host for non-file uri not supported');
    }
  }
  return replacePathHasError;
}

const FILE_PROTOCOL_PREFIX = 'file:///';

export function resolveFileUrl(
  url: string,
  refUrl: string,
  localSrcRoot?: string,
  skipReplacePathError?: boolean
): string {
  if (isUrlHttp(url)) {
    return url;
  }
  let error: string | undefined;
  if (!localSrcRoot) {
    error = 'can not use file url without localSrcRoot';
  }
  // unix absolute path
  if (localSrcRoot && localSrcRoot[0] === '/') {
    localSrcRoot = localSrcRoot.slice(1);
  }
  if (!error && localSrcRoot && url.startsWith(FILE_PROTOCOL_PREFIX) &&
    !url.slice(FILE_PROTOCOL_PREFIX.length).startsWith(localSrcRoot)) {
    error = 'file url not starting with localSrcRoot is forbidden';
  }
  if (!error && localSrcRoot && refUrl.startsWith(FILE_PROTOCOL_PREFIX) &&
    !refUrl.slice(FILE_PROTOCOL_PREFIX.length).startsWith(localSrcRoot)) {
    error = 'file refUrl not starting with localSrcRoot is forbidden';
  }
  if (!error && localSrcRoot) {
    if (localSrcRoot.endsWith('/')) {
      localSrcRoot = localSrcRoot.slice(0, -1);
    }
    if (url.startsWith('//')) {
      url = FILE_PROTOCOL_PREFIX + localSrcRoot + url.slice(1);
    } else if (url.startsWith('/')) {
      url = FILE_PROTOCOL_PREFIX + localSrcRoot + url;
    } else if (!url.startsWith(FILE_PROTOCOL_PREFIX)) {
      // relative url
      const absoluteRefUri = URI(FILE_PROTOCOL_PREFIX +
        refUrl.slice(FILE_PROTOCOL_PREFIX.length + localSrcRoot.length));
      const uri = URI(url).absoluteTo(absoluteRefUri);
      url = FILE_PROTOCOL_PREFIX + localSrcRoot + uri.pathname() + uri.hash();
    }
  }
  if (error) {
    if (skipReplacePathError) {
      log.warn(error, url, refUrl, localSrcRoot);
      return '';
    } else {
      log.warn(error, url, refUrl, localSrcRoot);
      throw new Error(error);
    }
  }

  return url;
}

/**
 * Create a resource
 * @param type {@link CreateResourceArgument.type}
 * @param depth {@link CreateResourceArgument.depth}
 * @param url {@link CreateResourceArgument.rawUrl}
 * @param refUrl {@link CreateResourceArgument.refUrl}
 * @param refSavePath {@link CreateResourceArgument.refSavePath}
 * @param refType {@link CreateResourceArgument.refType}
 * @param localRoot {@link CreateResourceArgument.localRoot}
 * @param localSrcRoot {@link CreateResourceArgument.localSrcRoot}
 * @param encoding {@link CreateResourceArgument.encoding}
 * @param keepSearch {@link CreateResourceArgument.keepSearch}
 * @param skipReplacePathError {@link CreateResourceArgument.skipReplacePathError}
 * @param generateSavePathFn {@link CreateResourceArgument.generateSavePathFn}
 * @return the resource
 */
export function createResource({
  type,
  depth,
  url,
  refUrl,
  refSavePath,
  refType,
  localRoot,
  localSrcRoot,
  encoding,
  keepSearch,
  skipReplacePathError,
  generateSavePathFn
}: CreateResourceArgument): Resource {
  const rawUrl: string = url;
  const refUri: URI = URI(refUrl);
  let replacePathHasError = false;
  if (url.startsWith(FILE_PROTOCOL_PREFIX) ||
    refUrl.startsWith(FILE_PROTOCOL_PREFIX)) {
    // file url should never have search
    keepSearch = false;
    url = resolveFileUrl(url, refUrl, localSrcRoot, skipReplacePathError);
    if (!url) {
      replacePathHasError = true;
      url = rawUrl;
    }
  }
  if (!replacePathHasError && url.startsWith('//')) {
    // url with the same protocol
    url = refUri.protocol() + ':' + url;
  } else if (!replacePathHasError && url[0] === '/') {
    // absolute path
    url = refUri.protocol() + '://' + refUri.host() + url;
  }
  let uri = URI(url);

  if (!replacePathHasError && uri.is('relative')) {
    uri = uri.absoluteTo(refUri);
    url = uri.toString();
  }

  if (!replacePathHasError &&
    checkAbsoluteUri(uri, refUri, skipReplacePathError, url, refUrl, type)) {
    replacePathHasError = true;
  }

  let downloadLink: string;
  if (uri.protocol() === 'file') {
    // file downloadLink contains no search
    downloadLink = uri.clone().search('').hash('').toString();
  } else {
    downloadLink = uri.clone().hash('').toString();
  }

  const implGenerateSavePath = generateSavePathFn || generateSavePath;

  // make savePath and replaceUri
  const savePath = replacePathHasError ? rawUrl : implGenerateSavePath(
    uri, type === ResourceType.Html, keepSearch, localSrcRoot);
  if (!refSavePath) {
    refSavePath = implGenerateSavePath(refUri, refType === ResourceType.Html,
      false, localSrcRoot);
  }
  const replaceUri = replacePathHasError ? URI(rawUrl) :
    URI(urlOfSavePath(savePath)).relativeTo(urlOfSavePath(refSavePath));

  // recover hash
  if (uri.hash()) {
    replaceUri.hash(uri.hash());
  }

  // remove search if not keepSearch
  if (!keepSearch && uri.search()) {
    uri.search('');
    url = uri.toString();
  }

  const resource: Resource = {
    type,
    depth,
    encoding: encoding || (type === ResourceType.Binary ? null : 'utf8'),
    url,
    rawUrl,
    downloadLink,
    refUrl,
    refSavePath,
    savePath,
    localRoot,
    replacePath: replaceUri.toString(),
    createTimestamp: Date.now(),
    body: undefined,
    meta: {},
    uri,
    refUri,
    replaceUri,
    host: uri.hostname()
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
    resource.downloadTime =
      resource.finishTimestamp - resource.downloadStartTimestamp;
  }
  if (resource.body instanceof ArrayBuffer || resource.body instanceof Uint8Array) {
    resource.body = Buffer.from(resource.body);
  } else if (ArrayBuffer.isView(resource.body)) {
    resource.body = Buffer.from(
      resource.body.buffer, resource.body.byteOffset, resource.body.byteLength);
  }
  return resource;
}
