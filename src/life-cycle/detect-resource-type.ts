import {ResourceType} from '../resource.js';
import {arrayToMap, isSiteMap} from '../util.js';

// immutable
export const binaryExtension = arrayToMap([
  'gif', 'jpg', 'jpeg', 'png',
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

/**
 * Return the extension of the path or the url,
 * from the last '.' to end of string in the last portion of the path.
 * If there is no '.' in the last portion of the path,
 * then it returns an empty string.
 *
 * @see path.extname
 * @param url the url to evaluate.
 */
export function lowerCaseExtension(url: string): string | void {
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
    return  endIndex === -1 ?
      url.slice(lastIndex + 1).toLowerCase() :
      url.slice(lastIndex + 1, endIndex).toLowerCase();
  }
}

export function detectResourceType(
  url: string,
  type: ResourceType
): ResourceType {
  if (isSiteMap(url)) {
    return ResourceType.SiteMap;
  }
  if (type === ResourceType.Html) {
    const extension: string | void = lowerCaseExtension(url);
    if (extension) {
      if (binaryExtension[extension]) {
        return ResourceType.Binary;
      } else if ('css' === extension) {
        return ResourceType.Css;
      } else if ('svg' === extension) {
        return ResourceType.Svg;
      }
    }
  }
  return type;
}
