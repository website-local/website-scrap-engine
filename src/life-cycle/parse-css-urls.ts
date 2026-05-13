const embeddedRegexp = /^data:(.*?),(.*?)/;
const commentRegexp = /\/\*([\s\S]*?)\*\//g;
const urlsRegexp =
  /(?:@import\s+)?url\s*\(\s*(("(.*?)")|('(.*?)')|(.*?))\s*\)|(?:@import\s+)(("(.*?)")|('(.*?)')|(.*?))[\s;]/ig;

export interface CssUrlMatch {
  url: string;
  start: number;
  end: number;
}

function matchUrl(match: RegExpExecArray): {
  url?: string;
  captureIndex?: number;
} {
  if (match[3]) return {url: match[3], captureIndex: 3};
  if (match[5]) return {url: match[5], captureIndex: 5};
  if (match[6]) return {url: match[6], captureIndex: 6};
  if (match[9]) return {url: match[9], captureIndex: 9};
  if (match[11]) return {url: match[11], captureIndex: 11};
  if (match[12]) return {url: match[12], captureIndex: 12};
  return {};
}

function captureStart(match: RegExpExecArray, captureIndex: number): number {
  const capture = match[captureIndex];
  const offset = capture ? match[0].indexOf(capture) : -1;
  return offset < 0 ? match.index : match.index + offset;
}

/**
 * Parse urls from css text.
 *
 * Ignores duplicate urls and embedded data resources.
 */
export default function parseCssUrls(cssText: string): string[] {
  return parseCssUrlMatches(cssText)
    .map(match => match.url)
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

export function parseCssUrlMatches(cssText: string): CssUrlMatch[] {
  const urls: string[] = [];
  const matches: CssUrlMatch[] = [];
  // Preserve text length so match offsets still point into the original CSS.
  const uncommentedCssText = cssText.replace(commentRegexp,
    comment => ' '.repeat(comment.length));
  let match: RegExpExecArray | null;
  urlsRegexp.lastIndex = 0;
  while ((match = urlsRegexp.exec(uncommentedCssText))) {
    const {url, captureIndex} = matchUrl(match);
    if (!url || captureIndex === undefined ||
      embeddedRegexp.test(url.trim())) {
      continue;
    }
    if (!urls.includes(url)) {
      urls.push(url);
    }
    const start = captureStart(match, captureIndex);
    matches.push({
      url,
      start,
      end: start + url.length
    });
  }
  urlsRegexp.lastIndex = 0;
  return matches;
}
