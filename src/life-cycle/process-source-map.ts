import {DownloadResource, SubmitResourceFunc} from './types';
import {StaticDownloadOptions} from '../options';
import {Resource, ResourceEncoding, ResourceType} from '../resource';
import {PipelineExecutor} from './pipeline-executor';

// https://developer.mozilla.org/docs/Web/HTTP/Headers/SourceMap
export const SOURCE_MAP_HEADER = 'SourceMap'.toLowerCase();
export const X_SOURCE_MAP_HEADER = 'X-SourceMap'.toLowerCase();

// See https://sourcemaps.info/spec.html
export const sourceMapPrefix = [
  '//# sourceMappingURL=',
  '//@ sourceMappingURL=',
  '/*# sourceMappingURL='
];

/*
https://en.wikipedia.org/wiki/Percent-encoding
RFC 3986 section 2.2 Reserved Characters (January 2005)
!	#	$	&	'	(	)	*	+	,	/	:	;	=	?	@	[	]
RFC 3986 section 2.3 Unreserved Characters (January 2005)
A	B	C	D	E	F	G	H	I	J	K	L	M	N	O	P	Q	R	S	T	U	V	W	X	Y	Z
a	b	c	d	e	f	g	h	i	j	k	l	m	n	o	p	q	r	s	t	u	v	w	x	y	z
0	1	2	3	4	5	6	7	8	9	-	_	.	~

Note: The char * is excluded.
*/
export const uriCharBitSet = [0, -1342178342, -1342177281, 1207959550];

export const isUriChar = (char: number): boolean => {
  return char < 0xff && !!(uriCharBitSet[char >>> 5] & (1 << char));
};

export const unsupportedEncoding: Set<NonNullable<BufferEncoding>> = new Set([
  'utf16le',
  'ucs2',
  'ucs-2'
]);

export async function processSourceMap(
  res: DownloadResource,
  submit: SubmitResourceFunc,
  options: StaticDownloadOptions,
  pipeline: PipelineExecutor): Promise<DownloadResource | void> {
  const {headers} = res.meta;
  let urls: string[] = [];
  const depth: number = res.depth + 1;
  if (headers) {
    const header = headers[SOURCE_MAP_HEADER] || headers[X_SOURCE_MAP_HEADER];
    if (header?.length) {
      if (Array.isArray(header)) {
        urls = header;
      } else {
        urls = [header];
      }
    }
  }
  const resources: Resource[] = [];
  let url: string | void, r: Resource | void;
  if (urls.length) {
    // noinspection DuplicatedCode
    for (let i = 0, l = urls.length; i < l; i++) {
      url = urls[i];
      r = await pipeline.createAndProcessResource(
        url, ResourceType.Binary, depth, null, res);
      if (!r) continue;
      if (!r.shouldBeDiscardedFromDownload) {
        resources.push(r);
      }
    }
  }
  let body: Buffer | string;
  if (typeof res.body === 'string' || Buffer.isBuffer(res.body)) {
    body = res.body;
  } else if (res.body instanceof ArrayBuffer) {
    body = Buffer.from(res.body);
  } else if (ArrayBuffer.isView(res.body)) {
    body = Buffer.from(res.body.buffer);
  } else {
    // we can not process that
    if (resources.length) {
      submit(resources);
    }
    return res;
  }

  if (Buffer.isBuffer(body) &&
    res.encoding &&
    unsupportedEncoding.has(res.encoding.toLowerCase() as BufferEncoding)) {
    // we can not process that
    // TODO: UCS-2/UTF-16 encoding
    if (resources.length) {
      submit(resources);
    }
    return res;
  }

  let shouldReplaceBody = false;
  for (const prefix of sourceMapPrefix) {
    let startIndex = body.indexOf(prefix);
    if (startIndex < 0) {
      continue;
    }
    startIndex += prefix.length;
    let endIndex: number = startIndex;
    let url = '';
    if (Buffer.isBuffer(body)) {
      while (endIndex < body.length) {
        if (!isUriChar(body[endIndex])) {
          break;
        }
        endIndex++;
      }
      if (endIndex > startIndex) {
        const encoding: ResourceEncoding = res.encoding || 'utf8';
        url = body.toString(encoding, startIndex, endIndex);
      }
    } else {
      // string
      while (endIndex < body.length) {
        if (!isUriChar(body.charCodeAt(endIndex))) {
          break;
        }
        endIndex++;
      }
      if (endIndex > startIndex) {
        url = body.slice(startIndex, endIndex);
      }
    }
    if (url) {
      r = await pipeline.createAndProcessResource(
        url, ResourceType.Binary, depth, null, res);
      if (!r) continue;
      const {replacePath} = r;
      if (replacePath !== url && replacePath[0] !== '#') {
        if (typeof body === 'string') {
          body = body.slice(0, startIndex) + replacePath + body.slice(endIndex);
          shouldReplaceBody = true;
        } else {
          // buffer
          if (replacePath.length <= url.length) {
            // 0x20 -> ' '.charCodeAt(0)
            const buffer = Buffer.alloc(endIndex - startIndex, 0x20);
            buffer.write(replacePath);
            buffer.copy(body, startIndex);
          } else {
            const buffer = Buffer.from(replacePath);
            const newBody = Buffer.alloc(
              body.byteLength + buffer.byteLength - endIndex + startIndex);
            body.copy(newBody, 0, 0, startIndex);
            buffer.copy(newBody, startIndex);
            body.copy(newBody,
              buffer.byteLength + startIndex, endIndex);
            body = newBody;
          }
          shouldReplaceBody = true;
        }

      }
      if (!r.shouldBeDiscardedFromDownload) {
        resources.push(r);
      }
    }
  }
  if (resources.length) {
    submit(resources);
  }
  if (shouldReplaceBody) {
    res.body = body;
  }
  return res;
}
