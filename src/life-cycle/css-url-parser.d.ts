/**
 * Parse urls from css file
 * @param cssText
 * @return It ignores duplicated urls and base64 encoded resources.
 * If no urls found empty array will be returned.
 */
declare function parseCssUrls(cssText: string): string[];

declare module 'css-url-parser' {
  export default parseCssUrls;
}
