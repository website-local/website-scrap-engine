import {LinkRedirectFunc} from '../pipeline';

/**
 * Skip unprocessable links
 */
export const skipLinks: LinkRedirectFunc = (url: string) : string | void=> {
  if (url.startsWith('#') ||
    url.startsWith('data:') ||
    url.startsWith('mailto:') ||
    url.startsWith('javascript:') ||
    url.startsWith('about:') ||
    url.startsWith('chrome:') ||
    url.startsWith('news:') ||
    url.startsWith('irc:')) {
    return;
  }
  return url;
};
