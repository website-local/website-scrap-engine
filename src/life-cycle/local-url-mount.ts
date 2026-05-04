import path from 'node:path';
import type {Stats} from 'node:fs';
import {promises as fs} from 'node:fs';
import type {Resource} from '../resource.js';
import {ResourceType} from '../resource.js';
import type {StaticDownloadOptions} from '../options.js';
import type {
  DownloadResource,
  DownloadResourceFunc,
  RequestOptions
} from './types.js';
import type {PipelineExecutor} from './pipeline-executor.js';
import {mkdirRetry} from '../io.js';
import {
  escapePath,
  isUrlHttp,
  orderUrlSearch,
  simpleHashString
} from '../util.js';

export type LocalUrlMountCaseMode =
  | 'exact'
  | 'lowercase'
  | 'uppercase'
  | 'caseInsensitive';

export interface LocalUrlMountIndexOptions {
  enabled?: boolean;
  names?: string[];
  extensionFallbacks?: string[];
}

export type LocalUrlMountNotFound =
  | 'fallback'
  | 'return404'
  | 'discard'
  | 'throw';

export interface LocalUrlMountContentTypeOptions {
  inferFromExtension?: boolean;
  defaultContentType?: string;
}

export type LocalUrlMountSearchMode =
  | 'ignore'
  | 'preserve'
  | 'appendHash';

export interface LocalUrlMountLimits {
  maxFileSize?: number;
  allowStreamingBinary?: boolean;
}

export interface LocalUrlMountCacheOptions {
  caseInsensitiveDirectoryEntries?: boolean;
}

export interface LocalUrlMount {
  /**
   * Local directory root. Must be absolute.
   */
  root: string;

  /**
   * Static HTTP(S) URL prefix to overlay.
   */
  urlPrefix: string;

  /**
   * Higher priority mounts are evaluated first.
   */
  priority?: number;

  /**
   * Case/read strategy for matching local filesystem entries.
   */
  caseMode?: LocalUrlMountCaseMode;

  /**
   * Directory and extension fallback behavior for HTML resources.
   */
  index?: LocalUrlMountIndexOptions;

  /**
   * What to do when this mount matches but no local file exists.
   */
  notFound?: LocalUrlMountNotFound;

  /**
   * Optional content-type behavior.
   */
  contentType?: LocalUrlMountContentTypeOptions;

  /**
   * Optional behavior for query strings.
   */
  search?: LocalUrlMountSearchMode;

  /**
   * Optional safety limits.
   */
  limits?: LocalUrlMountLimits;

  /**
   * Cache directory listings used by caseInsensitive lookup.
   */
  cache?: LocalUrlMountCacheOptions;
}

export interface LocalUrlMountOptions {
  mounts: LocalUrlMount[];
}

export interface LocalUrlMountMeta {
  root: string;
  urlPrefix: string;
  localPath?: string;
  candidatePaths: string[];
  source: 'localUrlMount';
  statusCode?: number;
}

export class LocalUrlMountNotFoundError extends Error {
  readonly code = 'LOCAL_URL_MOUNT_NOT_FOUND';
  readonly statusCode?: number;
  readonly response?: {statusCode: number};

  constructor(
    message: string,
    readonly mount: LocalUrlMountMeta,
    statusCode?: number
  ) {
    super(message);
    this.name = 'LocalUrlMountNotFoundError';
    this.statusCode = statusCode;
    if (statusCode !== undefined) {
      this.response = {statusCode};
    }
  }
}

export class LocalUrlMountFileSizeError extends Error {
  readonly code = 'LOCAL_URL_MOUNT_FILE_SIZE_LIMIT';

  constructor(
    message: string,
    readonly mount: LocalUrlMountMeta,
    readonly maxFileSize: number,
    readonly actualFileSize: number
  ) {
    super(message);
    this.name = 'LocalUrlMountFileSizeError';
  }
}

interface CompiledLocalUrlMount {
  root: string;
  urlPrefix: string;
  origin: string;
  prefixPath: string;
  priority: number;
  order: number;
  caseMode: LocalUrlMountCaseMode;
  index: Required<LocalUrlMountIndexOptions>;
  notFound: LocalUrlMountNotFound;
  contentType: Required<LocalUrlMountContentTypeOptions>;
  search: LocalUrlMountSearchMode;
  limits: Required<Pick<LocalUrlMountLimits, 'allowStreamingBinary'>> &
    Pick<LocalUrlMountLimits, 'maxFileSize'>;
  cache: Required<LocalUrlMountCacheOptions>;
  directoryCache: Map<string, Map<string, string>>;
}

interface MatchedMount {
  mount: CompiledLocalUrlMount;
  remainingPath: string;
  search: string;
}

interface ResolvedCandidate {
  localPath: string;
  attemptedPath: string;
}

interface LocalFileMatch {
  localPath: string;
  stats: Stats;
  candidatePaths: string[];
}

interface LocalFileResolution {
  match?: LocalFileMatch;
  candidatePaths: string[];
}

const DEFAULT_INDEX_NAMES = ['index.html', 'index.htm'];
const DEFAULT_EXTENSION_FALLBACKS = ['.html'];

const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8'
};

export function localUrlMounts(
  mounts: LocalUrlMount[] | LocalUrlMountOptions
): DownloadResourceFunc {
  const compiledMounts = compileMounts(Array.isArray(mounts) ?
    mounts : mounts.mounts);
  const mountsByOrigin = bucketMountsByOrigin(compiledMounts);

  return async (
    res: Resource,
    requestOptions: RequestOptions,
    options: StaticDownloadOptions,
    pipeline: PipelineExecutor
  ): Promise<DownloadResource | Resource | void> => {
    void requestOptions;
    void pipeline;
    if (res.body) {
      return res as DownloadResource;
    }
    if (!isUrlHttp(res.downloadLink)) {
      return res;
    }
    let url: URL;
    try {
      url = new URL(res.downloadLink);
    } catch {
      return res;
    }
    const matched = matchMount(mountsByOrigin, url);
    if (!matched) {
      return res;
    }
    const rawPath = extractRawPath(res.downloadLink);
    if (rawPath && hasUnsafeDecodedPath(rawPath)) {
      return handleNotFound(res, matched.mount, []);
    }
    if (res.type === ResourceType.StreamingBinary &&
      !matched.mount.limits.allowStreamingBinary) {
      return res;
    }

    const hadDownloadStart = res.downloadStartTimestamp !== undefined;
    ensureDownloadStarted(res);
    const fileResolution = await findLocalFile(
      matched.mount, matched.remainingPath, matched.search, res.type);
    if (!fileResolution.match) {
      if (!hadDownloadStart) {
        clearDownloadStart(res);
      }
      return handleNotFound(res, matched.mount, fileResolution.candidatePaths);
    }
    const {match: localFile} = fileResolution;

    if (matched.mount.limits.maxFileSize !== undefined &&
      localFile.stats.size > matched.mount.limits.maxFileSize) {
      const meta = createMeta(matched.mount, localFile.candidatePaths,
        localFile.localPath);
      res.meta.localUrlMount = meta;
      throw new LocalUrlMountFileSizeError(
        'local URL mount file exceeds maxFileSize: ' + localFile.localPath,
        meta,
        matched.mount.limits.maxFileSize,
        localFile.stats.size
      );
    }

    await applyLocalFile(res, options, matched.mount, localFile);
    if (res.type === ResourceType.StreamingBinary) {
      return undefined;
    }
    return res as DownloadResource;
  };
}

function bucketMountsByOrigin(
  mounts: CompiledLocalUrlMount[]
): Map<string, CompiledLocalUrlMount[]> {
  const byOrigin = new Map<string, CompiledLocalUrlMount[]>();
  for (const mount of mounts) {
    const originMounts = byOrigin.get(mount.origin);
    if (originMounts) {
      originMounts.push(mount);
    } else {
      byOrigin.set(mount.origin, [mount]);
    }
  }
  return byOrigin;
}

function compileMounts(mounts: LocalUrlMount[]): CompiledLocalUrlMount[] {
  return mounts.map((mount, order) => {
    if (!path.isAbsolute(mount.root)) {
      throw new TypeError('localUrlMounts: root must be absolute: ' + mount.root);
    }
    const root = path.resolve(mount.root);
    const prefixUrl = new URL(mount.urlPrefix);
    if (prefixUrl.protocol !== 'http:' && prefixUrl.protocol !== 'https:') {
      throw new TypeError(
        'localUrlMounts: urlPrefix must be HTTP(S): ' + mount.urlPrefix);
    }
    if (prefixUrl.search || prefixUrl.hash) {
      throw new TypeError(
        'localUrlMounts: urlPrefix must not include search or hash: ' +
        mount.urlPrefix);
    }
    return {
      root,
      urlPrefix: prefixUrl.toString(),
      origin: prefixUrl.origin,
      prefixPath: normalizePrefixPath(prefixUrl.pathname),
      priority: mount.priority ?? 0,
      order,
      caseMode: mount.caseMode ?? 'exact',
      index: {
        enabled: mount.index?.enabled ?? true,
        names: mount.index?.names ?? DEFAULT_INDEX_NAMES,
        extensionFallbacks: mount.index?.extensionFallbacks ??
          DEFAULT_EXTENSION_FALLBACKS
      },
      notFound: mount.notFound ?? 'fallback',
      contentType: {
        inferFromExtension: mount.contentType?.inferFromExtension ?? true,
        defaultContentType: mount.contentType?.defaultContentType ?? ''
      },
      search: mount.search ?? 'ignore',
      limits: {
        allowStreamingBinary: mount.limits?.allowStreamingBinary ?? true,
        maxFileSize: mount.limits?.maxFileSize
      },
      cache: {
        caseInsensitiveDirectoryEntries:
          mount.cache?.caseInsensitiveDirectoryEntries ?? true
      },
      directoryCache: new Map()
    };
  }).sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    if (a.prefixPath.length !== b.prefixPath.length) {
      return b.prefixPath.length - a.prefixPath.length;
    }
    return a.order - b.order;
  });
}

function normalizePrefixPath(prefixPath: string): string {
  if (!prefixPath || prefixPath === '/') {
    return '/';
  }
  return prefixPath.endsWith('/') ?
    prefixPath.slice(0, -1) : prefixPath;
}

function matchMount(
  mountsByOrigin: Map<string, CompiledLocalUrlMount[]>,
  url: URL
): MatchedMount | void {
  const mounts = mountsByOrigin.get(url.origin);
  if (!mounts) {
    return;
  }
  for (const mount of mounts) {
    const pathName = url.pathname || '/';
    if (mount.prefixPath === '/') {
      return {
        mount,
        remainingPath: pathName.slice(1),
        search: url.search
      };
    }
    if (pathName === mount.prefixPath) {
      return {mount, remainingPath: '', search: url.search};
    }
    if (pathName.startsWith(mount.prefixPath + '/')) {
      return {
        mount,
        remainingPath: pathName.slice(mount.prefixPath.length + 1),
        search: url.search
      };
    }
  }
}

function extractRawPath(downloadLink: string): string | void {
  const protocolIndex = downloadLink.indexOf('://');
  if (protocolIndex < 0) {
    return;
  }
  const authorityStart = protocolIndex + 3;
  let pathStart = downloadLink.indexOf('/', authorityStart);
  const searchStart = downloadLink.indexOf('?', authorityStart);
  const hashStart = downloadLink.indexOf('#', authorityStart);
  const end = minPositive(searchStart, hashStart, downloadLink.length);
  if (pathStart < 0 || pathStart > end) {
    pathStart = end;
  }
  if (pathStart === end) {
    return '/';
  }
  return downloadLink.slice(pathStart, end);
}

function minPositive(a: number, b: number, fallback: number): number {
  if (a < 0 && b < 0) {
    return fallback;
  }
  if (a < 0) {
    return b;
  }
  if (b < 0) {
    return a;
  }
  return Math.min(a, b);
}

function hasUnsafeDecodedPath(pathName: string): boolean {
  const rawSegments = pathName.split('/').filter(Boolean);
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }
    if (!isSafePathSegment(segment)) {
      return true;
    }
  }
  return false;
}

async function findLocalFile(
  mount: CompiledLocalUrlMount,
  remainingPath: string,
  search: string,
  type: ResourceType | number
): Promise<LocalFileResolution> {
  const decoded = decodeRemainingPath(remainingPath);
  if (!decoded) {
    return {candidatePaths: []};
  }
  const searchSuffix = createSearchSuffix(search, mount.search);
  const candidateSegments = createCandidateSegments(
    decoded.segments, decoded.trailingSlash, searchSuffix, mount, type);
  const candidatePaths: string[] = [];

  for (const segments of candidateSegments) {
    const resolved = await resolveCandidate(mount, segments);
    candidatePaths.push(resolved.attemptedPath);
    if (!resolved.localPath) {
      continue;
    }
    let stats: Stats;
    try {
      stats = await fs.stat(resolved.localPath);
    } catch (e) {
      if (isFileMissingError(e)) {
        continue;
      }
      throw e;
    }
    if (!stats.isFile()) {
      continue;
    }
    return {
      match: {
        localPath: resolved.localPath,
        stats,
        candidatePaths
      },
      candidatePaths
    };
  }
  return {candidatePaths};
}

function decodeRemainingPath(
  remainingPath: string
): {segments: string[]; trailingSlash: boolean} | void {
  const trailingSlash = remainingPath === '' || remainingPath.endsWith('/');
  const rawSegments = remainingPath.split('/').filter(Boolean);
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return;
    }
    if (!isSafePathSegment(segment)) {
      return;
    }
    segments.push(segment);
  }
  return {segments, trailingSlash};
}

function isSafePathSegment(segment: string): boolean {
  return segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    !segment.includes(':');
}

function createSearchSuffix(
  search: string,
  mode: LocalUrlMountSearchMode
): string {
  if (!search || mode === 'ignore') {
    return '';
  }
  const orderedSearch = orderUrlSearch(search);
  if (mode === 'appendHash') {
    return '_' + simpleHashString(orderedSearch);
  }
  return escapePath(orderedSearch);
}

function createCandidateSegments(
  segments: string[],
  trailingSlash: boolean,
  searchSuffix: string,
  mount: CompiledLocalUrlMount,
  type: ResourceType | number
): string[][] {
  const candidates: string[][] = [];
  const isHtml = type === ResourceType.Html;
  const lastSegment = segments[segments.length - 1];
  const hasExtension = !!lastSegment && !!path.extname(lastSegment);
  const useHtmlFallbacks = isHtml && mount.index.enabled &&
    (trailingSlash || !hasExtension);

  if (!trailingSlash) {
    candidates.push(applySearchSuffix(segments, searchSuffix));
  }
  if (useHtmlFallbacks) {
    for (const indexName of mount.index.names) {
      candidates.push(applySearchSuffix([...segments, indexName], searchSuffix));
    }
    if (segments.length > 0) {
      const baseSegments = segments.slice(0, -1);
      for (const ext of mount.index.extensionFallbacks) {
        candidates.push(applySearchSuffix(
          [...baseSegments, lastSegment + ext], searchSuffix));
      }
    }
  }
  return dedupeCandidates(candidates);
}

function applySearchSuffix(segments: string[], suffix: string): string[] {
  if (!suffix || segments.length === 0) {
    return segments;
  }
  const result = segments.slice();
  const last = result[result.length - 1];
  const ext = path.extname(last);
  result[result.length - 1] = ext ?
    last.slice(0, -ext.length) + suffix + ext :
    last + suffix;
  return result;
}

function dedupeCandidates(candidates: string[][]): string[][] {
  const used = new Set<string>();
  const result: string[][] = [];
  for (const candidate of candidates) {
    const key = candidate.join('\0');
    if (used.has(key)) {
      continue;
    }
    used.add(key);
    result.push(candidate);
  }
  return result;
}

async function resolveCandidate(
  mount: CompiledLocalUrlMount,
  segments: string[]
): Promise<ResolvedCandidate> {
  const attemptedSegments = transformSegments(mount, segments);
  const attemptedPath = path.resolve(mount.root, ...attemptedSegments);
  if (!isPathInside(mount.root, attemptedPath)) {
    return {attemptedPath, localPath: ''};
  }
  if (mount.caseMode !== 'caseInsensitive') {
    return {attemptedPath, localPath: attemptedPath};
  }
  const localPath = await resolveCaseInsensitivePath(mount, segments);
  if (!localPath || !isPathInside(mount.root, localPath)) {
    return {attemptedPath, localPath: ''};
  }
  return {attemptedPath, localPath};
}

function transformSegments(
  mount: CompiledLocalUrlMount,
  segments: string[]
): string[] {
  if (mount.caseMode === 'lowercase') {
    return segments.map(segment => segment.toLowerCase());
  }
  if (mount.caseMode === 'uppercase') {
    return segments.map(segment => segment.toUpperCase());
  }
  return segments;
}

async function resolveCaseInsensitivePath(
  mount: CompiledLocalUrlMount,
  segments: string[]
): Promise<string | void> {
  let currentPath = mount.root;
  for (const segment of segments) {
    const entries = await getCaseInsensitiveDirectoryEntries(mount, currentPath);
    if (!entries) {
      return;
    }
    const actualSegment = entries.get(segment.toLowerCase());
    if (!actualSegment) {
      return;
    }
    currentPath = path.join(currentPath, actualSegment);
  }
  return currentPath;
}

async function getCaseInsensitiveDirectoryEntries(
  mount: CompiledLocalUrlMount,
  dirPath: string
): Promise<Map<string, string> | void> {
  if (mount.cache.caseInsensitiveDirectoryEntries) {
    const cached = mount.directoryCache.get(dirPath);
    if (cached) {
      return cached;
    }
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch (e) {
    if (isFileMissingError(e)) {
      return;
    }
    throw e;
  }
  const map = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (!map.has(key)) {
      map.set(key, entry);
    }
  }
  if (mount.cache.caseInsensitiveDirectoryEntries) {
    mount.directoryCache.set(dirPath, map);
  }
  return map;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isFileMissingError(e: unknown): boolean {
  const code = (e as {code?: string})?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function ensureDownloadStarted(res: Resource): void {
  if (!res.downloadStartTimestamp) {
    res.downloadStartTimestamp = Date.now();
    res.waitTime = res.downloadStartTimestamp - res.createTimestamp;
  }
}

function clearDownloadStart(res: Resource): void {
  delete res.downloadStartTimestamp;
  delete res.waitTime;
}

function handleNotFound(
  res: Resource,
  mount: CompiledLocalUrlMount,
  candidatePaths: string[]
): Resource | void {
  const meta = createMeta(mount, candidatePaths);
  res.meta.localUrlMount = meta;
  switch (mount.notFound) {
  case 'fallback':
    return res;
  case 'discard':
    return undefined;
  case 'return404':
    meta.statusCode = 404;
    throw new LocalUrlMountNotFoundError(
      'local URL mount returned 404 for ' + res.downloadLink,
      meta,
      404
    );
  case 'throw':
    throw new LocalUrlMountNotFoundError(
      'local URL mount file not found for ' + res.downloadLink,
      meta
    );
  }
}

async function applyLocalFile(
  res: Resource,
  options: StaticDownloadOptions,
  mount: CompiledLocalUrlMount,
  localFile: LocalFileMatch
): Promise<void> {
  res.meta.headers = createHeaders(mount, localFile.localPath, localFile.stats);
  res.meta.localUrlMount = createMeta(
    mount, localFile.candidatePaths, localFile.localPath);
  if (res.type === ResourceType.StreamingBinary) {
    const fileDestPath = path.join(
      res.localRoot ?? options.localRoot, res.savePath);
    await mkdirRetry(path.dirname(fileDestPath));
    await fs.copyFile(localFile.localPath, fileDestPath);
  } else {
    res.body = await fs.readFile(localFile.localPath, {
      encoding: res.encoding
    });
  }
  res.finishTimestamp = Date.now();
  res.downloadTime = res.finishTimestamp - res.downloadStartTimestamp!;
}

function createHeaders(
  mount: CompiledLocalUrlMount,
  localPath: string,
  stats: Stats
): Record<string, string> {
  const headers: Record<string, string> = {
    'last-modified': stats.mtime.toISOString(),
    'content-length': stats.size.toString()
  };
  const contentType = getContentType(mount, localPath);
  if (contentType) {
    headers['content-type'] = contentType;
  }
  return headers;
}

function getContentType(
  mount: CompiledLocalUrlMount,
  localPath: string
): string | void {
  if (mount.contentType.inferFromExtension) {
    const ext = path.extname(localPath).toLowerCase();
    if (CONTENT_TYPES[ext]) {
      return CONTENT_TYPES[ext];
    }
  }
  return mount.contentType.defaultContentType || undefined;
}

function createMeta(
  mount: CompiledLocalUrlMount,
  candidatePaths: string[],
  localPath?: string
): LocalUrlMountMeta {
  return {
    root: mount.root,
    urlPrefix: mount.urlPrefix,
    localPath,
    candidatePaths,
    source: 'localUrlMount'
  };
}
