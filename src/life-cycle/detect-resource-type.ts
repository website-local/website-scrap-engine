import {ResourceType} from '../resource';
import {arrayToMap, isSiteMap} from '../util';

// immutable
export const binaryExtension = arrayToMap([
  'gif', 'jpg', 'jpeg', 'png',
  // probably we could parse svg and download links
  'svg',
  'js', 'jsm', 'json', 'txt',
  'woff2', 'ttf', 'ttc',
  'xul',
  'jar', 'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
  'mp3', 'ogg',
  'mp4', 'flv', 'm4v', 'mkv', 'webm',
  'msi',
  'xpi',
  'rdf',
  'pdf',
  'dia',
  'eot',
  'psd'
], true);

export function detectResourceType(
  url: string,
  type: ResourceType
): ResourceType {
  if (isSiteMap(url)) {
    return ResourceType.SiteMap;
  }
  if (type === ResourceType.Html) {
    const hashIndex: number = url.lastIndexOf('#');
    const searchIndex: number = hashIndex === -1 ?
      url.lastIndexOf('?') :
      url.lastIndexOf('?', hashIndex);
    const endIndex: number = searchIndex === -1 ?
      hashIndex :
      hashIndex === -1 ? searchIndex : Math.min(searchIndex, hashIndex);
    const endPath: number = endIndex === -1 ?
      url.lastIndexOf('/') :
      url.lastIndexOf('/', endIndex);
    const lastIndex: number = endIndex === -1 ?
      url.lastIndexOf('.') :
      url.lastIndexOf('.', endIndex);
    if (lastIndex !== -1 && lastIndex > endPath) {
      const extension: string = endIndex === -1 ?
        url.slice(lastIndex + 1).toLowerCase() :
        url.slice(lastIndex + 1, endIndex).toLowerCase();
      if (binaryExtension[extension]) {
        return ResourceType.Binary;
      } else if ('css' === extension) {
        return ResourceType.Css;
      }
    }
  }
  return type;
}
