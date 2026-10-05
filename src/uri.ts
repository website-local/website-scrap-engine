import {posix} from 'node:path';
import {isIP} from 'node:net';
import {domainToASCII, domainToUnicode} from 'node:url';
import * as queries from './uri-query.js';
import type {QueryInput, QueryData, QueryMatcher, QuerySelector} from './uri-query.js';
export type {QueryInput, QueryValue, QueryData, QueryMatcher, QuerySelector} from './uri-query.js';

export interface UriParts {
  protocol?: string | null;
  username?: string | null;
  password?: string | null;
  hostname?: string | null;
  port?: string | number | null;
  path?: string | null;
  query?: string | QueryInput | null;
  fragment?: string | null;
  urn?: boolean;
}
export type UriInput = string | URL | NativeUri | UriParts;
export type QuerySetter = string | QueryInput | null |
  ((this: NativeUri, data: QueryData) => QueryInput | void);
export type UriPredicate = 'relative' | 'absolute' | 'url' | 'urn' | 'domain' | 'name' |
  'sld' | 'idn' | 'punycode' | 'ip' | 'ip4' | 'ipv4' | 'inet4' | 'ip6' | 'ipv6' | 'inet6';

const schemeExpression = /^[a-z][a-z\d+.-]*:/i;
const defaultPorts: Record<string, string> = Object.assign(Object.create(null),
  {http: '80', https: '443', ws: '80', wss: '443', ftp: '21'});
const referenceScheme = 'reference:';
const simpleHostname = /^(?:[a-z\d_-]+\.)*[a-z\d_-]+\.?$/i;
const nativeHostname = /xn--|(?:^|\.)(?:\d+|0x[\da-f]+)\.?$/i;
// Native setters encode ASCII controls; the fast paths must reject those bytes.
// eslint-disable-next-line no-control-regex
const unsafePath = /[\u0000-\u0020\u007f-\uffff"<>?`{}\\#]|(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;
// eslint-disable-next-line no-control-regex
const unsafeQuery = /[\u0000-\u0020\u007f-\uffff"<>#']/;
// eslint-disable-next-line no-control-regex
const unsafeHash = /[\u0000-\u0020\u007f-\uffff"<>`]/;
const stripBrackets = (value: string): string => value.startsWith('[') ? value.slice(1, -1) : value;
const decoded = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
const decodePathSegment = (value: string): string => decoded(value).replace(/[/?#]/g, queries.encode);
const decodePath = (value: string): string => value.split('/').map(decodePathSegment).join('/');
const needsPathRecoding = /[^-a-z\d._~$&+,;=:@/]/i;
const needsPathNormalization = /(?:^|\/)\.{1,2}(?:\/|$)|\/{2}/;
function recodePath(value: string): string {
  if (!needsPathRecoding.test(value)) return value;
  return value.split('/').map(segment => {
    try {
      return queries.encode(decodeURIComponent(segment)).replace(/%(?:24|26|2B|2C|3B|3D|3A|40)/g,
        part => String.fromCharCode(parseInt(part.slice(1), 16)));
    } catch { return segment; }
  }).join('/');
}

/**
 * URIjs-style APIs with WHATWG absolute parsing. Underscored fields are ordinary
 * implementation properties, not a supported public mutation API. All stored
 * state is cloneable; native URL objects are temporary parsing/validation tools.
 */
export class NativeUri {
  _protocol = '';
  _hostname = '';
  _username = '';
  _password = '';
  _port = '';
  _path = '';
  _search = '';
  _hash = '';
  _authority = false;
  _opaque = false;
  _cached: string | undefined = '';
  _duplicates = URI.duplicateQueryParameters;
  _escapeSpaces = URI.escapeQuerySpace;

  constructor(input: UriInput = '', base?: UriInput) {
    if (input instanceof NativeUri) {
      this._copy(input);
      if (base !== undefined) this._load(new URL(this.toString(), baseHref(base)));
    } else if (input instanceof URL) {
      this._load(base === undefined ? input : new URL(input.href, baseHref(base)));
    } else {
      if (input === null || input === undefined) throw new TypeError('Invalid URI input');
      const value = typeof input === 'string' ? input : buildParts(input);
      if (base !== undefined) this._load(new URL(value, baseHref(base)));
      else if (value.startsWith('//')) this._load(new URL(referenceScheme + value), true);
      else if (schemeExpression.test(value)) this._load(new URL(value));
      else {
        const hash = value.indexOf('#');
        const head = hash < 0 ? value : value.slice(0, hash);
        const query = head.indexOf('?');
        this._path = query < 0 ? head : head.slice(0, query);
        this._search = query < 0 ? '' : head.slice(query);
        this._hash = hash < 0 ? '' : value.slice(hash);
        this._cached = value;
      }
    }
  }

  _load(value: URL, network = false): this {
    const href = value.href, protocol = value.protocol;
    this._protocol = network ? '' : protocol.slice(0, -1);
    this._hostname = stripBrackets(value.hostname);
    this._username = value.username;
    this._password = value.password;
    this._port = value.port;
    this._path = value.pathname;
    this._authority = href.startsWith('//', protocol.length);
    this._opaque = !this._authority && !this._path.startsWith('/');
    this._search = value.search;
    if (!this._search) {
      const hash = href.indexOf('#');
      if (href.charCodeAt((hash < 0 ? href.length : hash) - 1) === 63) this._search = '?';
    }
    this._hash = value.hash || (href.endsWith('#') ? '#' : '');
    this._cached = network ? href.slice(referenceScheme.length) : href;
    return this;
  }

  _copy(other: NativeUri): this {
    this._protocol = other._protocol; this._hostname = other._hostname;
    this._username = other._username; this._password = other._password;
    this._port = other._port; this._path = other._path;
    this._search = other._search; this._hash = other._hash;
    this._authority = other._authority; this._opaque = other._opaque;
    this._cached = other._cached; this._duplicates = other._duplicates;
    this._escapeSpaces = other._escapeSpaces;
    return this;
  }

  toString(): string {
    return this._cached ??= (this._protocol ? this._protocol + ':' : '') +
      (this._authority ? '//' + this.authority() :
        this._protocol && this._path.startsWith('//') ? '/.' : '') + this._path + this._search + this._hash;
  }
  valueOf(): string { return this.toString(); }
  toJSON(): string { return this.toString(); }
  clone(): NativeUri { return new NativeUri(this); }
  build(defer?: boolean): this { void defer; this._cached = undefined; return this; }
  href(): string;
  href(value: UriInput): this;
  href(value?: UriInput): string | this {
    return value === undefined ? this.toString() : this._copy(new NativeUri(value));
  }

  protocol(): string;
  protocol(value: string | null): this;
  protocol(value?: string | null): string | this {
    if (value === undefined) return this._protocol;
    const text = value ?? '';
    const next = (text.endsWith(':') ? text.slice(0, -1) : text).toLowerCase();
    if (next && !/^[a-z][a-z\d+.-]*$/.test(next)) throw new TypeError('Invalid protocol');
    if (next === this._protocol) return this;
    if (this._authority && (!next || next in defaultPorts && this._protocol in defaultPorts)) {
      this._protocol = next;
      if (this._port === defaultPorts[next]) this._port = '';
      return this.build();
    }
    const tail = this.toString().slice(this._protocol ? this._protocol.length + 1 : 0);
    const replacement = new NativeUri((next ? next + ':' : '') + tail);
    replacement._duplicates = this._duplicates;
    replacement._escapeSpaces = this._escapeSpaces;
    return this._copy(replacement);
  }
  scheme(): string;
  scheme(value: string | null): this;
  scheme(value?: string | null): string | this { return value === undefined ? this.protocol() : this.protocol(value); }

  host(): string;
  host(value: string): this;
  host(value?: string): string | this {
    if (value === undefined) return (this._hostname.includes(':') ? '[' + this._hostname + ']' : this._hostname) +
      (this._port ? ':' + this._port : '');
    if (/[/?#@\\]/.test(value)) throw new TypeError('Invalid authority');
    if (value === this.host()) return this;
    const parsed = new URL((this._protocol || referenceScheme.slice(0, -1)) + '://' + value + '/');
    if (this._opaque) throw new TypeError('Cannot set the authority of an opaque URL');
    this._hostname = stripBrackets(parsed.hostname);
    this._port = parsed.port;
    this._authority = true;
    if (!this._path.startsWith('/')) this._path = '/' + this._path;
    return this.build();
  }
  hostname(): string;
  hostname(value: string): this;
  hostname(value?: string): string | this {
    if (value === undefined) return this._hostname;
    if (value === this._hostname) return this;
    if (this._authority && this._protocol in defaultPorts && simpleHostname.test(value) && !nativeHostname.test(value)) {
      this._hostname = value.toLowerCase();
      return this.build();
    }
    const host = value.includes(':') && !value.startsWith('[') ? '[' + value + ']' : value;
    return this.host(host + (this._port ? ':' + this._port : ''));
  }
  port(): string;
  port(value: string | number | null): this;
  port(value?: string | number | null): string | this {
    if (value === undefined) return this._port;
    const raw = value === null || value === 0 ? '' : String(value);
    const text = raw.startsWith(':') ? raw.slice(1) : raw;
    if (text === this._port) return this;
    if (!this._hostname || this._protocol === 'file') throw new TypeError('A port requires an authority');
    let next = '';
    if (text) {
      if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0 || value > 65535) throw new TypeError('Invalid port');
        next = text;
      } else {
        if (!/^\d+$/.test(text) || Number(text) > 65535) throw new TypeError('Invalid port');
        next = String(Number(text));
      }
    }
    this._port = next === defaultPorts[this._protocol] ? '' : next;
    return this.build();
  }

  username(): string;
  username(value: string): this;
  username(value?: string): string | this { return value === undefined ? this._username : this._credential('username', value); }
  password(): string;
  password(value: string): this;
  password(value?: string): string | this { return value === undefined ? this._password : this._credential('password', value); }
  _credential(key: 'username' | 'password', value: string): this {
    if (!this._hostname || this._protocol === 'file') throw new TypeError('Credentials require a network authority');
    const parsed = new URL((this._protocol ? '' : referenceScheme) + this.toString());
    parsed[key] = value;
    return this._load(parsed, !this._protocol);
  }
  userinfo(): string;
  userinfo(value: string): this;
  userinfo(value?: string): string | this {
    if (value === undefined) return this._username + (this._password ? ':' + this._password : '');
    const colon = value.indexOf(':');
    return this.username(colon < 0 ? value : value.slice(0, colon)).password(colon < 0 ? '' : value.slice(colon + 1));
  }
  authority(): string;
  authority(value: string): this;
  authority(value?: string): string | this {
    if (value === undefined) return (this.userinfo() ? this.userinfo() + '@' : '') + this.host();
    if (/[/?#\\]/.test(value)) throw new TypeError('Invalid authority');
    const parsed = new URL((this._protocol || referenceScheme.slice(0, -1)) + '://' + value + '/');
    this.host(parsed.host);
    this._username = parsed.username; this._password = parsed.password;
    return this.build();
  }
  origin(): string;
  origin(value: UriInput): this;
  origin(value?: UriInput): string | this {
    if (value === undefined) return this.authority() ? (this._protocol ? this._protocol + '://' : '') + this.authority() : '';
    const next = new NativeUri(value);
    return this.protocol(next.protocol()).authority(next.authority());
  }

  path(): string;
  path(decode: boolean): string;
  path(value: string | null): this;
  path(value?: string | boolean | null): string | this {
    if (value === undefined || typeof value === 'boolean') return value ? decodePath(this._path) : this._path;
    const next = value ?? '';
    if (next === this._path) return this;
    if (this._opaque) throw new TypeError('Cannot set the path of an opaque URL');
    if (this._authority || this._protocol) {
      if (!this._authority || unsafePath.test(next)) {
        const parsed = new URL((this._protocol ? '' : referenceScheme) + this.toString());
        parsed.pathname = next;
        if (!this._authority) return this._load(parsed);
        this._path = parsed.pathname;
      } else this._path = this._authority && !next.startsWith('/') &&
        (next || this._protocol in defaultPorts || this._protocol === 'file') ? '/' + next : next;
    } else this._path = next;
    return this.build();
  }
  pathname(): string;
  pathname(decode: boolean): string;
  pathname(value: string | null): this;
  pathname(value?: string | boolean | null): string | this {
    return typeof value === 'boolean' ? this.path(value) : value === undefined ? this.path() : this.path(value);
  }
  search(): string;
  search(parse: true): QueryData;
  search(parse: false): this;
  search(value: QuerySetter): this;
  search(value?: QuerySetter | boolean): string | QueryData | this {
    if (value === undefined) return this._search === '?' ? '' : this._search;
    if (value === false) return this.search('');
    if (value === true) return this.query(true);
    if (typeof value !== 'string') return this.query(value);
    let next = value && !value.startsWith('?') ? '?' + value : value;
    if (next === this._search) return this;
    if (unsafeQuery.test(next) && (this._protocol || this._authority)) {
      const parsed = new URL((this._protocol ? '' : referenceScheme) + this.toString());
      parsed.search = next; next = parsed.search || (next ? '?' : '');
    }
    this._search = next;
    return this.build();
  }
  query(): string;
  query(parse: true): QueryData;
  query(parse: false): this;
  query(value: QuerySetter): this;
  query(value?: QuerySetter | boolean): string | QueryData | this {
    if (value === undefined) return this._search.slice(1);
    if (value === false) return this.search('');
    if (value === true) return queries.parseQuery(this._search, this._escapeSpaces);
    if (typeof value === 'string') return this.search(value);
    if (typeof value === 'function') {
      const data = this.query(true);
      return this.query(value.call(this, data) || data);
    }
    // buildQuery already escapes every character the public search setter checks.
    const query = queries.buildQuery(value, this._duplicates, this._escapeSpaces);
    const next = query ? '?' + query : '';
    if (next === this._search) return this;
    this._search = next;
    return this.build();
  }
  setQuery(name: string | QueryInput, value?: QueryInput[string]): this {
    return this.query(queries.setQuery(this.query(true), name, value));
  }
  addQuery(name: string | QueryInput, value?: QueryInput[string]): this {
    return this.query(queries.addQuery(this.query(true), name, value));
  }
  removeQuery(name: QuerySelector | readonly string[], value?: QueryMatcher): this {
    return this.query(queries.removeQuery(this.query(true), name, value));
  }
  hasQuery(name: QuerySelector, value?: QueryMatcher, withinArray?: boolean): boolean {
    if (typeof name === 'string' && value === undefined) {
      return queries.hasQueryKey(this._search, name, this._escapeSpaces);
    }
    return queries.hasQuery(this.query(true), name, value, withinArray);
  }
  setSearch(name: string | QueryInput, value?: QueryInput[string]): this { return this.setQuery(name, value); }
  addSearch(name: string | QueryInput, value?: QueryInput[string]): this { return this.addQuery(name, value); }
  removeSearch(name: QuerySelector | readonly string[], value?: QueryMatcher): this { return this.removeQuery(name, value); }
  hasSearch(name: QuerySelector, value?: QueryMatcher, withinArray?: boolean): boolean { return this.hasQuery(name, value, withinArray); }
  duplicateQueryParameters(value: boolean): this { this._duplicates = value; return this; }
  escapeQuerySpace(value: boolean): this { this._escapeSpaces = value; return this; }
  preventInvalidHostname(value: boolean): this { void value; return this; }

  hash(): string;
  hash(value: string | null): this;
  hash(value?: string | null): string | this {
    if (value === undefined) return this._hash === '#' ? '' : this._hash;
    let next = value && !value.startsWith('#') ? '#' + value : value ?? '';
    if (next === this._hash) return this;
    if (unsafeHash.test(next) && (this._protocol || this._authority)) {
      const parsed = new URL((this._protocol ? '' : referenceScheme) + this.toString());
      parsed.hash = next; next = parsed.hash || (next ? '#' : '');
    }
    this._hash = next;
    return this.build();
  }
  fragment(): string;
  fragment(value: string | null): this;
  fragment(value?: string | null): string | this { return value === undefined ? this._hash.slice(1) : this.hash(value); }
  resource(): string;
  resource(value: string): this;
  resource(value?: string): string | this {
    if (value === undefined) return this._path + this._search + this._hash;
    const next = new NativeUri(value);
    return this.path(next.path()).search(next._search).hash(next._hash);
  }
  filename(): string;
  filename(decode: boolean): string;
  filename(value: string): this;
  filename(value?: string | boolean): string | this {
    if (typeof value !== 'string') {
      const name = this._opaque ? '' : this._path.slice(this._path.lastIndexOf('/') + 1);
      return value ? decodePathSegment(name) : name;
    }
    return this.path(this._path.slice(0, this._path.lastIndexOf('/') + 1) + recodePath(value).replace(/^\//, ''));
  }
  directory(): string;
  directory(decode: boolean): string;
  directory(value: string): this;
  directory(value?: string | boolean): string | this {
    if (typeof value !== 'string') {
      const dir = this._opaque ? '' : this._path === '/' ? '/' :
        this._path.slice(0, Math.max(0, this._path.lastIndexOf('/'))) || (this._hostname ? '/' : '');
      return value ? decodePath(dir) : dir;
    }
    return this.path((value ? recodePath(value).replace(/\/$/, '') + '/' : '') + this.filename());
  }
  suffix(): string;
  suffix(decode: boolean): string;
  suffix(value: string): this;
  suffix(value?: string | boolean): string | this {
    const name = this.filename(), dot = name.lastIndexOf('.');
    const suffix = dot < 0 || !/^[a-z\d%]+$/i.test(name.slice(dot + 1)) ? '' : name.slice(dot + 1);
    if (typeof value !== 'string') return value ? decodePathSegment(suffix) : suffix;
    return this.path(this._path.slice(0, this._path.lastIndexOf('/') + 1) +
      (suffix ? name.slice(0, dot) : name) + (value ? '.' + recodePath(value.replace(/^\./, '')) : ''));
  }
  segment(): string[];
  segment(index: number): string | undefined;
  segment(value: string | readonly string[]): this;
  segment(index: number, value: string | null): this;
  segment(index?: number | string | readonly string[], value?: string | null): string[] | string | undefined | this {
    const separator = this._opaque ? ':' : '/';
    const absolute = this._path.startsWith('/');
    let parts = (absolute ? this._path.slice(1) : this._path).split(separator);
    if (index === undefined) return parts;
    if (typeof index === 'number') {
      if (!Number.isInteger(index)) throw new TypeError('Segment index must be an integer');
      const at = index < 0 ? Math.max(0, parts.length + index) : index;
      if (value === undefined) return parts[at];
      if (at >= parts.length) {
        if (value) { if (parts.at(-1) === '') parts.pop(); parts.push(value.replace(/^\/+|\/+$/g, '')); }
      } else if (!value) parts.splice(at, 1);
      else parts[at] = value.replace(/^\/+|\/+$/g, '');
    } else if (typeof index === 'string') {
      if (parts.at(-1) === '') parts.pop();
      parts.push(index.replace(/^\/+|\/+$/g, ''));
    } else parts = index.map(part => part.replace(/^\/+|\/+$/g, '')).filter((part, i, all) => part || i === all.length - 1);
    return this.path(recodePath((absolute ? '/' : '') + parts.join(separator)));
  }
  segmentCoded(): string[];
  segmentCoded(index: number): string | undefined;
  segmentCoded(value: string | readonly string[]): this;
  segmentCoded(index: number, value: string | null): this;
  segmentCoded(index?: number | string | readonly string[], value?: string | null): string[] | string | undefined | this {
    if (index === undefined) return this.segment().map(decoded);
    if (typeof index === 'number') {
      if (value === undefined) { const item = this.segment(index); return item === undefined ? item : decoded(item); }
      return this.segment(index, value === null ? null : queries.encode(value));
    }
    return this.segment(typeof index === 'string' ? queries.encode(index) : index.map(queries.encode));
  }

  tld(): string;
  tld(simple: boolean): string;
  tld(value: string): this;
  tld(value?: string | boolean): string | this {
    const labels = this._hostname.split('.');
    if (typeof value !== 'string') return isIP(this._hostname) ? '' : labels.at(-1) ?? '';
    labels[labels.length - 1] = value;
    return this.hostname(labels.join('.'));
  }
  domain(): string;
  domain(simple: boolean): string;
  domain(value: string): this;
  domain(value?: string | boolean): string | this {
    const labels = this._hostname.split('.');
    if (typeof value !== 'string') return isIP(this._hostname) ? this._hostname : labels.slice(-2).join('.');
    return this.hostname([...labels.slice(0, -2), value].join('.'));
  }
  subdomain(): string;
  subdomain(value: string): this;
  subdomain(value?: string): string | this {
    if (value === undefined) return isIP(this._hostname) ? '' : this._hostname.split('.').slice(0, -2).join('.');
    return this.hostname((value ? value + '.' : '') + this.domain());
  }
  is(kind: UriPredicate): boolean {
    switch (kind.toLowerCase()) {
    case 'relative': return !this._hostname && !this._opaque;
    case 'absolute': return !!this._hostname || this._opaque;
    case 'url': return !this._opaque;
    case 'urn': return this._opaque;
    case 'domain': case 'name': return !!this._hostname && !isIP(this._hostname);
    case 'sld': return false; // No bundled public-suffix/second-level-domain list.
    case 'ip': return !!isIP(this._hostname);
    case 'ip4': case 'ipv4': case 'inet4': return isIP(this._hostname) === 4;
    case 'ip6': case 'ipv6': case 'inet6': return isIP(this._hostname) === 6;
    case 'idn': return /[\u0080-\uffff]/.test(this._hostname);
    case 'punycode': return /(?:^|\.)xn--/i.test(this._hostname);
    default: throw new TypeError('Unsupported URI predicate: ' + kind);
    }
  }

  normalize(): this { return this.normalizeProtocol().normalizeHostname().normalizePort().normalizePath().normalizeQuery().normalizeFragment(); }
  normalizeProtocol(): this { return this.protocol(this._protocol.toLowerCase()); }
  normalizeHostname(): this {
    if (!this._hostname) return this;
    if (simpleHostname.test(this._hostname) && !nativeHostname.test(this._hostname)) {
      return this.hostname(this._hostname.toLowerCase());
    }
    return this.hostname(domainToASCII(this._hostname) || this._hostname);
  }
  normalizePort(): this { return this._port ? this.port(this._port) : this; }
  normalizePath(): this {
    if (!this._path || this._opaque) return this;
    let path = recodePath(this._path);
    if (needsPathNormalization.test(path)) {
      path = posix.normalize(/\/(?:\.|\.\.)$/.test(path) ? path + '/' : path);
      if (path === '.' || path === './') path = '';
    }
    if (!this._protocol && !this._authority && /^[^/]*:/.test(path)) path = './' + path;
    return path === this._path ? this : this.path(path);
  }
  normalizePathname(): this { return this.normalizePath(); }
  normalizeQuery(): this { return this._search ? this.query(this.query(true)) : this; }
  normalizeSearch(): this { return this.normalizeQuery(); }
  normalizeFragment(): this {
    if (!this._hash) return this;
    const normalized = this._hash === '#' ? '' : normalizePercent(this._hash);
    // Text directives give even URL-unreserved '-' semantic meaning. Neither
    // decode their payload nor introduce a directive by decoding its marker.
    return normalized.includes(':~:') ? this : this.hash(normalized);
  }
  normalizeHash(): this { return this.normalizeFragment(); }
  unicode(): this { return this; }
  iso8859(): never { throw new TypeError('ISO-8859-1 URL encoding is not supported'); }
  readable(): string {
    const copy = this.clone().normalize();
    copy._username = ''; copy._password = '';
    copy._hostname = domainToUnicode(copy._hostname) || copy._hostname;
    // Decode components independently so encoded separators remain unambiguous.
    copy._path = copy.path(true);
    if (copy._search) {
      copy._search = '?' + copy.query().split('&').map(pair => pair.split('=').map(value =>
        queries.decodeQuery(value, copy._escapeSpaces).replace(/&/g, '%26')).join('=')).join('&');
    }
    copy._hash = queries.decodeQuery(copy._hash, true);
    return copy.build().toString();
  }
  absoluteTo(base: UriInput): NativeUri {
    return new NativeUri(new URL(this.toString(), baseHref(base)));
  }
  relativeTo(base: UriInput): NativeUri {
    const other = base instanceof NativeUri ? base : new NativeUri(base);
    if (!this._protocol || !other._protocol || this._protocol !== other._protocol || this.host() !== other.host() ||
      this._username !== other._username || this._password !== other._password ||
      !this._path.startsWith('/') || !other._path.startsWith('/')) return this.clone();
    if (this._protocol === 'file' && /^\/[a-z]:/i.exec(this._path)?.[0].toLowerCase() !==
      /^\/[a-z]:/i.exec(other._path)?.[0].toLowerCase()) return this.clone();
    if (this._path.includes('//') || other._path.includes('//')) return this.clone();
    if (this._path === other._path) {
      if (this._search === other._search) return new NativeUri(this._hash);
      if (this._search) return new NativeUri(this._search + this._hash);
    }
    const baseDir = other._path.endsWith('/') ? other._path : posix.dirname(other._path);
    const targetDir = this._path.endsWith('/') ? this._path : posix.dirname(this._path);
    let relative = posix.relative(baseDir, targetDir);
    if (relative) relative += '/';
    relative += this._path.endsWith('/') ? (relative ? '' : './') : posix.basename(this._path);
    if (relative.split('/')[0].includes(':')) relative = './' + relative;
    return new NativeUri(relative + this._search + this._hash);
  }
  equals(other: UriInput = ''): boolean {
    const one = this.clone().normalize(), two = new NativeUri(other).normalize();
    if (one.toString() === two.toString()) return true;
    const a = one.query(true), b = two.query(true);
    if (one.query('').toString() !== two.query('').toString()) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key =>
      queries.hasQuery(b, key, a[key] as QueryMatcher));
  }
}

function baseHref(base: UriInput): string {
  return base instanceof NativeUri ? base.toString() :
    typeof base === 'string' || base instanceof URL ? String(base) : new NativeUri(base).toString();
}

function normalizePercent(value: string): string {
  return value.replace(/%[\da-f]{2}/gi, part => {
    const char = String.fromCharCode(parseInt(part.slice(1), 16));
    return /[a-z\d._~-]/i.test(char) ? char : part.toUpperCase();
  });
}
function buildParts(parts: UriParts): string {
  const protocol = (parts.protocol ?? '').replace(/:$/, '');
  const host = buildHost(parts);
  const user = buildUserinfo(parts);
  const query = typeof parts.query === 'string' ? parts.query : queries.buildQuery(parts.query ?? null);
  return (protocol ? protocol + ':' : '') + (host || protocol === 'file' ? '//' + user + host : '') +
    (host && parts.path && !parts.path.startsWith('/') ? '/' : '') + (parts.path ?? '') +
    (query ? '?' + query : '') + (parts.fragment ? '#' + parts.fragment : '');
}
function buildHost(parts: UriParts): string {
  const hostname = parts.hostname ?? '';
  return (hostname.includes(':') && !hostname.startsWith('[') ? '[' + hostname + ']' : hostname) +
    (parts.port ? ':' + parts.port : '');
}
function buildUserinfo(parts: UriParts): string {
  return (parts.username ?? '') + (parts.password ? ':' + parts.password : '') +
    (parts.username || parts.password ? '@' : '');
}

export type URI = NativeUri;
export interface URIConstructor {
  (value?: UriInput, base?: UriInput): NativeUri;
  new(value?: UriInput, base?: UriInput): NativeUri;
  prototype: NativeUri;
  duplicateQueryParameters: boolean;
  escapeQuerySpace: boolean;
  preventInvalidHostname: boolean;
  parse(value: string): UriParts;
  build(parts: UriParts): string;
  buildHost: typeof buildHost;
  buildUserinfo: typeof buildUserinfo;
  buildAuthority(parts: UriParts): string;
  parseHost(value: string, parts: UriParts): string;
  parseUserinfo(value: string, parts: UriParts): string;
  parseAuthority(value: string, parts: UriParts): string;
  encode: typeof queries.encode;
  decode: typeof queries.decode;
  encodeReserved(value: string): string;
  encodeQuery: typeof queries.encodeQuery;
  decodeQuery: typeof queries.decodeQuery;
  parseQuery: typeof queries.parseQuery;
  buildQuery: typeof queries.buildQuery;
  addQuery: typeof queries.addQuery;
  setQuery: typeof queries.setQuery;
  removeQuery: typeof queries.removeQuery;
  hasQuery: typeof queries.hasQuery;
  commonPath(one: string, two: string): string;
  joinPaths(...paths: UriInput[]): NativeUri;
  withinString(source: string, callback: (url: string, start: number, end: number, source: string) => string): string;
  unicode(): void;
  iso8859(): never;
}
export const URI = function URI(value: UriInput = '', base?: UriInput): NativeUri {
  return new NativeUri(value, base);
} as URIConstructor;
URI.prototype = NativeUri.prototype;
URI.duplicateQueryParameters = false;
URI.escapeQuerySpace = true;
URI.preventInvalidHostname = true;
URI.build = buildParts;
URI.buildHost = buildHost;
URI.buildUserinfo = buildUserinfo;
URI.buildAuthority = parts => buildUserinfo(parts) + buildHost(parts);
URI.parse = value => {
  const uri = new NativeUri(value);
  return {protocol: uri._protocol || null, username: uri._username || null,
    password: uri._password || null, hostname: uri._hostname || null,
    port: uri._port || null, path: uri._path, query: uri.query() || null,
    fragment: uri.fragment() || null, urn: uri._opaque};
};
URI.parseHost = (value, parts) => {
  const slash = value.indexOf('/');
  const host = slash < 0 ? value : value.slice(0, slash);
  const parsed = new NativeUri('//' + host + '/');
  parts.hostname = parsed.hostname() || null; parts.port = parsed.port() || null;
  return slash < 0 ? '/' : value.slice(slash);
};
URI.parseUserinfo = (value, parts) => {
  const slash = value.indexOf('/'), at = value.lastIndexOf('@', slash < 0 ? value.length : slash);
  if (at < 0) { parts.username = null; parts.password = null; return value; }
  const user = value.slice(0, at), colon = user.indexOf(':');
  parts.username = (colon < 0 ? user : user.slice(0, colon)) || null;
  parts.password = (colon < 0 ? '' : user.slice(colon + 1)) || null;
  return value.slice(at + 1);
};
URI.parseAuthority = (value, parts) => URI.parseHost(URI.parseUserinfo(value, parts), parts);
URI.encode = queries.encode; URI.decode = queries.decode;
URI.encodeReserved = value => encodeURI(value);
URI.encodeQuery = (value, spaces = URI.escapeQuerySpace) => queries.encodeQuery(value, spaces);
URI.decodeQuery = (value, spaces = URI.escapeQuerySpace) => queries.decodeQuery(value, spaces);
URI.parseQuery = (value, spaces = URI.escapeQuerySpace) => queries.parseQuery(value, spaces);
URI.buildQuery = (data, duplicates = URI.duplicateQueryParameters, spaces = URI.escapeQuerySpace) => queries.buildQuery(data, duplicates, spaces);
URI.addQuery = queries.addQuery; URI.setQuery = queries.setQuery;
URI.removeQuery = queries.removeQuery; URI.hasQuery = queries.hasQuery;
URI.commonPath = (one, two) => {
  let i = 0;
  while (i < one.length && i < two.length && one[i] === two[i]) i++;
  return one.slice(0, one.slice(0, i).lastIndexOf('/') + 1);
};
URI.joinPaths = (...paths) => {
  const values = paths.map(value => new NativeUri(value).path());
  return new NativeUri(values.join('/').replace(/\/{2,}/g, '/')).normalizePath();
};
URI.withinString = (source, callback) => source.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi,
  (url: string, offset: number) => callback(url, offset, offset + url.length, source));
URI.unicode = () => {};
URI.iso8859 = () => { throw new TypeError('ISO-8859-1 URL encoding is not supported'); };
export default URI;
