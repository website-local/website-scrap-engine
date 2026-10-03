const embeddedRegexp = /^data:(.*?),(.*?)/;
const commentRegexp = /\/\*([\s\S]*?)\*\//g;
const urlsRegexp =
  /(?:@import\s+)?url\s*\(\s*(?:"(.*?)"|'(.*?)'|(.*?))\s*\)|(?:@import\s+)(?:"(.*?)"|'(.*?)'|(.*?))[\s;]/ig;

export interface CssUrlMatch {
  url: string;
  start: number;
  end: number;
}

function captureIndex(match: RegExpExecArray): number {
  for (let index = 1; index <= 6; index++) {
    if (match[index]) return index;
  }
  return 0;
}

function captureStart(match: RegExpExecArray, captureIndex: number): number {
  // Quoted values can contain whitespace also present before the opening quote.
  if (captureIndex === 1 || captureIndex === 4) return match.index + match[0].indexOf('"') + 1;
  if (captureIndex === 2 || captureIndex === 5) return match.index + match[0].indexOf('\'') + 1;
  // Search within the argument, excluding the url()/@import syntax itself.
  const argumentStart = captureIndex === 3 ? match[0].indexOf('(') + 1 : '@import'.length;
  return match.index + match[0].indexOf(match[captureIndex], argumentStart);
}

/**
 * Parse urls from css text.
 *
 * Ignores duplicate urls and embedded data resources.
 */
export default function parseCssUrls(cssText: string): string[] {
  return [...new Set(parseCssUrlMatches(cssText).map(match => match.url))];
}

export function parseCssUrlMatches(cssText: string): CssUrlMatch[] {
  const matches: CssUrlMatch[] = [];
  // Preserve text length so match offsets still point into the original CSS.
  const uncommentedCssText = cssText.replace(commentRegexp,
    comment => ' '.repeat(comment.length));
  let match: RegExpExecArray | null;
  urlsRegexp.lastIndex = 0;
  while ((match = urlsRegexp.exec(uncommentedCssText))) {
    const index = captureIndex(match);
    const url = match[index];
    if (!index || !url ||
      embeddedRegexp.test(url.trim())) {
      continue;
    }
    const start = captureStart(match, index);
    matches.push({
      url,
      start,
      end: start + url.length
    });
  }
  urlsRegexp.lastIndex = 0;
  return matches;
}
