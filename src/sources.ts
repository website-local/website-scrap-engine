import {ResourceType} from './resource';

export interface SourceDefinition {
  selector: string;
  attr?: string;
  type: ResourceType;
}

// https://github.com/website-scraper/node-website-scraper
// /blob/66f5113475843ae86f12ea9e5d2ebcfade9f056e/lib/config/defaults.js
export const sources: SourceDefinition[] = [
  {selector: 'style', type: ResourceType.CssInline},
  {selector: '[style]', attr: 'style', type: ResourceType.CssInline},
  {selector: 'img', attr: 'src'},
  {selector: 'img', attr: 'srcset'},
  {selector: 'input', attr: 'src'},
  {selector: 'object', attr: 'data'},
  {selector: 'embed', attr: 'src'},
  {selector: 'param[name="movie"]', attr: 'value'},
  {selector: 'script', attr: 'src'},
  {selector: 'link[rel="stylesheet"]', attr: 'href', type: ResourceType.Css},
  {selector: 'link[rel*="icon"]', attr: 'href'},
  {selector: 'link[rel*="preload"]', attr: 'href'},
  // prefetch links not included by default
  // {selector: 'link[rel*="prefetch"]', attr: 'href'},
  {selector: 'svg *[xlink\\:href]', attr: 'xlink:href'},
  {selector: 'svg *[href]', attr: 'href'},
  {selector: 'picture source', attr: 'srcset'},
  {selector: 'meta[property="og\\:image"]', attr: 'content'},
  {selector: 'meta[property="og\\:image\\:url"]', attr: 'content'},
  {selector: 'meta[property="og\\:image\\:secure_url"]', attr: 'content'},
  {selector: 'meta[property="og\\:audio"]', attr: 'content'},
  {selector: 'meta[property="og\\:audio\\:url"]', attr: 'content'},
  {selector: 'meta[property="og\\:audio\\:secure_url"]', attr: 'content'},
  {selector: 'meta[property="og\\:video"]', attr: 'content'},
  {selector: 'meta[property="og\\:video\\:url"]', attr: 'content'},
  {selector: 'meta[property="og\\:video\\:secure_url"]', attr: 'content'},
  {selector: 'video', attr: 'src'},
  {selector: 'video source', attr: 'src'},
  {selector: 'video track', attr: 'src'},
  {selector: 'audio', attr: 'src'},
  {selector: 'audio source', attr: 'src'},
  {selector: 'audio track', attr: 'src'},
  {selector: 'frame', attr: 'src', type: ResourceType.Html},
  {selector: 'iframe', attr: 'src', type: ResourceType.Html},
  {selector: 'a', attr: 'href', type: ResourceType.Html},
  // https://github.com/website-scraper/node-website-scraper/pull/408
  {selector: '[background]', attr: 'background'},
].map((obj: Partial<SourceDefinition>) => {
  if (obj.selector && !obj.selector.startsWith('svg') && obj.attr) {
    obj.selector += `[${obj.attr}]`;
  }
  if (!obj.type) {
    obj.type = ResourceType.Binary;
  }
  return obj as SourceDefinition;
});

