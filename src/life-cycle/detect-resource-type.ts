import {DetectResourceTypeFunc} from '../pipeline';
import {ResourceType} from '../resource';
import {arrayToMap, isSiteMap} from '../util';

const binaryExtension = arrayToMap([
  'gif', 'jpg', 'jpeg', 'png',
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
]);

export const detectResourceType: DetectResourceTypeFunc = (
  url: string,
  type: ResourceType
): ResourceType => {
  if (isSiteMap(url)) {
    return ResourceType.SiteMap;
  }
  if (type === ResourceType.Html) {
    let lastIndex: number;
    if ((lastIndex = url.lastIndexOf('/')) != -1 &&
      (lastIndex = url.lastIndexOf('.', lastIndex + 1)) != -1) {
      const extension: string = url.slice(lastIndex).toLowerCase();
      if (binaryExtension[extension]) {
        return ResourceType.Binary;
      } else if ('css' === extension) {
        return ResourceType.Css;
      }
    }
  }
  return type;
};
