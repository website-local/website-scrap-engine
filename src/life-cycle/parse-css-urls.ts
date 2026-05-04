const embeddedRegexp = /^data:(.*?),(.*?)/;
const commentRegexp = /\/\*([\s\S]*?)\*\//g;
const urlsRegexp =
  /(?:@import\s+)?url\s*\(\s*(("(.*?)")|('(.*?)')|(.*?))\s*\)|(?:@import\s+)(("(.*?)")|('(.*?)')|(.*?))[\s;]/ig;

/**
 * Parse urls from css text.
 *
 * Ignores duplicate urls and embedded data resources.
 */
export default function parseCssUrls(cssText: string): string[] {
  const urls: string[] = [];
  const uncommentedCssText = cssText.replace(commentRegexp, '');
  let match: RegExpExecArray | null;
  urlsRegexp.lastIndex = 0;
  while ((match = urlsRegexp.exec(uncommentedCssText))) {
    const url = match[3] || match[5] || match[6] ||
      match[9] || match[11] || match[12];
    if (url && !embeddedRegexp.test(url.trim()) && !urls.includes(url)) {
      urls.push(url);
    }
  }
  urlsRegexp.lastIndex = 0;
  return urls;
}
