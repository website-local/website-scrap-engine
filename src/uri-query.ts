/** URIjs-compatible query operations, separate from WHATWG URL parsing. */
export type QueryValue = string | number | boolean | null | undefined;
export type QueryInput = Record<string, QueryValue | readonly QueryValue[]>;
export type QueryData = Record<string, string | null | (string | null)[]>;
export type QueryMatcher = QueryValue | readonly QueryValue[] | RegExp |
  ((value: QueryInput[string], key: string, data: QueryInput) => boolean);
export type QuerySelector = string | RegExp | Record<string, QueryMatcher>;

const needsEncoding = /[^a-z\d._~-]/i;

function encodeEscaped(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}

export function encode(value: string): string {
  // Most query names and values are already RFC 3986 unreserved characters.
  return typeof value === 'string' && !needsEncoding.test(value) ? value : encodeEscaped(value);
}

export function decode(value: string): string { return decodeURIComponent(value); }

export function encodeQuery(value: QueryValue, spaces = true): string {
  const text = String(value);
  if (!needsEncoding.test(text)) return text;
  const result = encodeEscaped(text);
  return spaces && text.includes(' ') ? result.replace(/%20/g, '+') : result;
}

export function decodeQuery(value: string, spaces = true): string {
  const text = spaces && value.includes('+') ? value.replace(/\+/g, ' ') : value;
  if (!text.includes('%')) return text;
  try { return decode(text); }
  catch { return value; }
}

export function parseQuery(value = '', spaces = true): QueryData {
  const result: QueryData = Object.create(null);
  let start = 0;
  while (value.charCodeAt(start) === 63) start++;
  // Advance both delimiters monotonically, including long runs of bare keys.
  // Searching anew for '=' in every bare entry would repeatedly scan the tail.
  let equal = value.indexOf('=', start);
  while (start < value.length) {
    let end = value.indexOf('&', start);
    if (end < 0) end = value.length;
    if (end > start) {
      const hasValue = equal >= start && equal < end;
      const key = decodeQuery(value.slice(start, hasValue ? equal : end), spaces);
      if (key !== '__proto__') {
        const item = hasValue ? decodeQuery(value.slice(equal + 1, end), spaces) : null;
        const previous = result[key];
        if (previous === undefined) result[key] = item;
        else if (Array.isArray(previous)) previous.push(item);
        else result[key] = [previous, item];
      }
    }
    start = end + 1;
    if (equal >= 0 && equal < start) equal = value.indexOf('=', start);
  }
  return result;
}

export function buildQuery(data: QueryInput | null, duplicates = false, spaces = true): string {
  if (!data) return '';
  let result = '';
  for (const key of Object.keys(data)) {
    if (key === '__proto__') continue;
    const value = data[key];
    if (value === undefined) continue;
    const name = encodeQuery(key, spaces);
    if (!Array.isArray(value)) {
      result += '&' + name + (value === null ? '' : '=' + encodeQuery(String(value), spaces));
      continue;
    }
    const seen = !duplicates && value.length > 2 ? new Set<string>() : undefined;
    let previous: string | undefined;
    for (const item of value) {
      if (item === undefined) continue;
      const text = String(item);
      if (!duplicates) {
        if (seen) {
          if (seen.has(text)) continue;
          seen.add(text);
        } else {
          // At most two values: one comparison replaces an allocated Set.
          if (text === previous) continue;
          previous = text;
        }
      }
      result += '&' + name + (item === null ? '' : '=' + encodeQuery(text, spaces));
    }
  }
  return result.slice(1);
}

export function setQuery(data: QueryInput, name: string | QueryInput,
  value?: QueryInput[string]): QueryInput {
  if (typeof name === 'string') {
    if (name !== '__proto__') data[name] = value === undefined ? null : value;
    return data;
  }
  for (const [key, item] of Object.entries(name)) {
    if (key !== '__proto__') data[key] = item;
  }
  return data;
}

export function addQuery(data: QueryInput, name: string | QueryInput,
  value?: QueryInput[string]): QueryInput {
  if (typeof name === 'string') appendQuery(data, name, value === undefined ? null : value);
  else for (const [key, item] of Object.entries(name)) appendQuery(data, key, item);
  return data;
}

function appendQuery(data: QueryInput, key: string, item: QueryInput[string]): void {
  if (key === '__proto__') return;
  const old = data[key];
  data[key] = old === undefined ? item :
    [...(Array.isArray(old) ? old : old === null ? [] : [old]), ...(Array.isArray(item) ? item : [item])];
}

function matches(actual: QueryValue, expected: QueryMatcher): boolean {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(String(actual));
  }
  return actual === null ? expected === null : String(actual) === String(expected);
}

export function removeQuery(data: QueryInput, name: QuerySelector | readonly string[],
  value?: QueryMatcher): QueryInput {
  if (Array.isArray(name)) {
    for (const key of name) delete data[key];
  } else if (typeof name === 'string') {
    if (value === undefined) delete data[name];
    else {
      const old = data[name];
      if (!Array.isArray(old)) {
        if (old === undefined || (Array.isArray(value) ?
          value.some(item => matches(old as QueryValue, item)) : matches(old as QueryValue, value))) delete data[name];
      } else {
        const remaining = Array.isArray(value) ?
          old.filter(item => !value.some(wanted => matches(item, wanted))) :
          old.filter(item => !matches(item, value));
        if (!remaining.length) delete data[name];
        else data[name] = remaining;
      }
    }
  } else if (name instanceof RegExp) {
    for (const key of Object.keys(data)) {
      name.lastIndex = 0;
      if (name.test(key)) delete data[key];
    }
  } else {
    for (const [key, item] of Object.entries(name)) removeQuery(data, key, item);
  }
  return data;
}

/** Existence checks need decoded keys only, with the same delimiters as parseQuery. */
export function hasQueryKey(value: string, name: string, spaces = true): boolean {
  if (name === '__proto__') return false;
  let start = 0;
  while (value.charCodeAt(start) === 63) start++;
  let equal = value.indexOf('=', start);
  while (start < value.length) {
    let end = value.indexOf('&', start);
    if (end < 0) end = value.length;
    if (end > start) {
      const keyEnd = equal >= start && equal < end ? equal : end;
      if (decodeQuery(value.slice(start, keyEnd), spaces) === name) return true;
    }
    start = end + 1;
    if (equal >= 0 && equal < start) equal = value.indexOf('=', start);
  }
  return false;
}

export function hasQuery(data: QueryInput, name: QuerySelector,
  value?: QueryMatcher, withinArray = false): boolean {
  if (name instanceof RegExp) {
    return Object.keys(data).some(key => {
      name.lastIndex = 0;
      return name.test(key) && hasQuery(data, key, value);
    });
  }
  if (typeof name !== 'string') {
    return Object.entries(name).every(([key, item]) => hasQuery(data, key, item));
  }
  const actual = data[name];
  if (value === undefined) return Object.hasOwn(data, name);
  if (typeof value === 'function') return !!value(actual, name, data);
  if (typeof value === 'boolean') return value === !!(Array.isArray(actual) ? actual.length : actual);
  if (Array.isArray(value)) {
    if (!Array.isArray(actual) || !withinArray && actual.length !== value.length) return false;
    const available = [...actual];
    return value.every(item => {
      const index = available.findIndex(v => matches(v, item));
      if (index < 0) return false;
      if (!withinArray) available.splice(index, 1);
      return true;
    });
  }
  if (Array.isArray(actual)) return withinArray && actual.some(item => matches(item, value));
  return actual !== undefined && matches(actual as QueryValue, value);
}
