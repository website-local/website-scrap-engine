declare module 'css-url-parser' {
  /**
   * Parse urls from css file
   * @param cssText
   * @return It ignores duplicated urls and base64 encoded resources.
   * If no urls found empty array will be returned.
   */
  export default function parseCssUrls(cssText: string): string[];
}
