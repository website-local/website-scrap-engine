const embeddedRegexp = /^data:(.*?),(.*?)/;
const whitespace = /\s/;
// Bounded captures keep failed fast-path attempts linear; unusual arguments
// fall through to the cached delimiter scanner with the same legacy semantics.
const shortUrl = /\s{0,32}(?:"([^"\r\n\u2028\u2029]{0,256})"|'([^'\r\n\u2028\u2029]{0,256})'|([^\s"'()]{1,256}))\s{0,32}\)/y;

export interface CssUrlMatch {
  url: string;
  start: number;
  end: number;
}

function maskComments(text: string): string {
  let from = 0, start = text.indexOf('/*');
  if (start < 0) return text;
  const parts: string[] = [];
  while (start >= 0) {
    const close = text.indexOf('*/', start + 2);
    if (close < 0) break;
    parts.push(text.slice(from, start), ' '.repeat(close + 2 - start));
    from = close + 2;
    start = text.indexOf('/*', from);
  }
  return parts.length ? parts.join('') + text.slice(from) : text;
}

// Each caller advances monotonically. Cache failed searches too, so unfinished
// arguments cannot repeatedly scan the same suffix for a missing delimiter.
function nextDelimiter(text: string, pattern: RegExp) {
  const found = {index: -1, end: -1};
  return (from: number): {index: number; end: number} => {
    if (found.index < from) {
      pattern.lastIndex = from;
      const match = pattern.exec(text);
      found.index = match ? match.index : Infinity;
      found.end = match ? pattern.lastIndex : Infinity;
    }
    return found;
  };
}

/** Parse CSS URLs, ignoring duplicates and embedded data resources. */
export default function parseCssUrls(cssText: string): string[] {
  return [...new Set(parseCssUrlMatches(cssText).map(match => match.url))];
}

export function parseCssUrlMatches(cssText: string): CssUrlMatch[] {
  const text = maskComments(cssText), matches: CssUrlMatch[] = [];
  const tokens = /url\s{0,32}\(\s{0,32}(?:"([^"\r\n\u2028\u2029]{0,256})"|'([^'\r\n\u2028\u2029]{0,256})'|([^\s"'()]{1,256}))\s{0,32}\)|url\s*\(|@import\s+/ig;
  const urlPrefix = /url\s*\(/iy;
  type Finder = ReturnType<typeof nextDelimiter>;
  let close: Finder | undefined, urlLine: Finder | undefined, importLine: Finder | undefined, importEnd: Finder | undefined;
  let urlQuotes: Finder[] | undefined, importQuotes: Finder[] | undefined;
  let lastClose = -1, lastContentEnd = -1;

  function argument(from: number, isUrl: boolean): {start: number; end: number; next: number; url?: string} | undefined {
    if (isUrl) {
      shortUrl.lastIndex = from;
      const match = shortUrl.exec(text);
      if (match) {
        const quoted = match[1] !== undefined ? '"' : match[2] !== undefined ? '\'' : '';
        const value = match[1] ?? match[2] ?? match[3];
        const start = from + (quoted ? match[0].indexOf(quoted) + 1 : match[0].indexOf(value));
        return {start, end: start + value.length, next: shortUrl.lastIndex, url: value};
      }
    }
    if (isUrl) while (from < text.length && whitespace.test(text[from])) from++;
    const quote = text[from] === '"' ? 0 : text[from] === '\'' ? 1 : -1;
    const line = (isUrl ? urlLine ??= nextDelimiter(text, /[\r\n\u2028\u2029]/g) :
      importLine ??= nextDelimiter(text, /[\r\n\u2028\u2029]/g))(from).index;
    if (quote >= 0) {
      const quotes = isUrl ? urlQuotes ??= [] : importQuotes ??= [];
      const finder = quotes[quote] ??= nextDelimiter(text, isUrl ?
        (quote ? /'\s*\)/g : /"\s*\)/g) : (quote ? /'[\s;]/g : /"[\s;]/g));
      const found = finder(from + 1);
      if (found.index < line) return {start: from + 1, end: found.index, next: found.end};
    }
    if (!isUrl) {
      const found = (importEnd ??= nextDelimiter(text, /[\s;]/g))(from);
      if (found.index < Infinity) return {start: from, end: found.index, next: found.end};
      return;
    }
    const found = (close ??= nextDelimiter(text, /\)/g))(from);
    if (found.index === Infinity) return;
    if (found.index !== lastClose) {
      lastClose = found.index;
      lastContentEnd = lastClose;
      while (lastContentEnd > 0 && whitespace.test(text[lastContentEnd - 1])) lastContentEnd--;
    }
    const end = Math.max(from, lastContentEnd);
    if (end <= line) return {start: from, end, next: found.end};
  }

  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text))) {
    // Ordinary arguments are captured by the token scan itself: no second
    // regex match, delimiter caches or intermediate argument object needed.
    const value = token[1] ?? token[2] ?? token[3];
    if (value !== undefined) {
      if (value && !embeddedRegexp.test(value.trim())) {
        const quote = token[1] !== undefined ? '"' : token[2] !== undefined ? '\'' : '';
        const offset = quote ? token[0].indexOf(quote) + 1 : token[0].indexOf(value, token[0].indexOf('(') + 1);
        const start = token.index + offset;
        matches.push({url: value, start, end: start + value.length});
      }
      continue;
    }
    let found;
    if (token[0][0] === '@') {
      urlPrefix.lastIndex = tokens.lastIndex;
      if (urlPrefix.test(text)) found = argument(urlPrefix.lastIndex, true);
      if (!found) found = argument(tokens.lastIndex, false);
    } else found = argument(tokens.lastIndex, true);
    if (!found) continue;
    tokens.lastIndex = found.next;
    const url = found.url ?? text.slice(found.start, found.end);
    if (url && !embeddedRegexp.test(url.trim())) matches.push({url, start: found.start, end: found.end});
  }
  return matches;
}
