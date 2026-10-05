import {test} from '@jest/globals';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {load} from 'cheerio';
import URI from '../src/uri.js';
import {createResource, ResourceType} from '../src/resource.js';
import {defaultDownloadOptions} from '../src/options.js';
import {defaultLifeCycle} from '../src/life-cycle/default-life-cycle.js';
import {PipelineExecutorImpl} from '../src/downloader/pipeline-executor-impl.js';
import {saveHtmlToDisk} from '../src/life-cycle/save-html-to-disk.js';
import {saveResourceToDisk} from '../src/life-cycle/save-resource-to-disk.js';

// Fixed seeds and bounded workloads keep failures reproducible in every CI job.
const seeds = [0x19b50cf8, 0x5fff228, 0x12345678];
function generator(seed: number) {
  let state = seed;
  return (limit: number): number => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % limit;
  };
}
const atoms = ['a', 'b:c', 'a%2Fb', '%23', '%25', '%252F', '%ZZ', '汉字',
  'space here', '.', '..', '%2e', '', 'x;y', 'quote\'', 'a+b'];
const origins = ['https://example.org', 'https://example.org:8080',
  'http://example.org', 'https://[::1]:8080', 'https://user:pass@example.org',
  'file://', 'custom://EXAMPLE.org'];
const tails = ['', '?', '#', '?#', '?x=a%20b&x=c#part', '#汉字', '?flag', '#:~:text=a%2Db'];

test.each(seeds)('relative references resolve to their target (seed %i)', seed => {
  const next = generator(seed);
  const path = (): string => '/' + Array.from({length: 1 + next(8)}, () => atoms[next(atoms.length)]).join('/');
  for (let sample = 0; sample < 400; sample++) {
    const origin = origins[next(origins.length)];
    const targetNative = new URL(origin + path() + tails[next(tails.length)]);
    const baseNative = new URL((sample % 3 ? origin : origins[next(origins.length)]) + path() + tails[next(tails.length)]);
    if (sample % 5 === 0) baseNative.pathname = targetNative.pathname;
    const source = URI(targetNative.href).duplicateQueryParameters(true).escapeQuerySpace(false);
    const base = URI(baseNative.href);
    const before = source.href(), baseBefore = base.href();
    const context = JSON.stringify({seed, sample, target: before, base: baseBefore});
    for (const input of [base, baseBefore, baseNative]) {
      const result = source.relativeTo(input);
      assert.equal(new URL(result.href(), baseNative).href, targetNative.href, context);
      assert.equal(source.absoluteTo(input).href(), targetNative.href, context);
      assert.equal(result.query({x: ['a b', 'a b']}).query(), 'x=a%20b&x=a%20b', context);
      assert.equal(source.href(), before, context);
      assert.equal(base.href(), baseBefore, context);
    }
  }
});

test('relative references preserve drive spelling, authority boundaries and first-segment colons', () => {
  const urls = ['file:///C:/a', 'file:///c:/b', 'file:///D:/c',
    'https://example.org/a', 'https://example.org:8080/a',
    'https://user:pass@example.org/a', 'https://[::1]/a', 'https://[::1]:8080/a',
    'https://example.org/a:b', 'https://example.org/x/a:b', 'https://example.org/a//b'];
  for (const target of urls) for (const base of urls) {
    const relative = URI(target).relativeTo(base).href();
    assert.equal(new URL(relative, base).href, new URL(target).href, JSON.stringify({target, base, relative}));
  }
  assert.equal(URI('https://example.org/a:b').relativeTo('https://example.org/c').href(), './a:b');
  for (const query of ['?', '?#', '?#part']) {
    const target = 'https://example.org/a' + query;
    assert.equal(URI(target).relativeTo('https://example.org/a?').href(), query);
    assert.equal(new URL(URI(target).relativeTo('https://example.org/a?').href(),
      'https://example.org/a?').href, target);
  }
});

test.each(seeds)('indexed segment reads stay coherent through mutations (seed %i)', seed => {
  const next = generator(seed);
  const lexical = ['a', '', 'b:c', '%2F', '%ZZ', '汉字', 'space here'];
  for (let sample = 0; sample < 180; sample++) {
    const parts = Array.from({length: 1 + next(12)}, () => lexical[next(lexical.length)]);
    const input = sample % 3 === 0 ? 'urn:' + parts.join(':') :
      (sample % 3 === 1 ? '/root/' : './root/') + parts.join('/');
    const uri = URI(input);
    for (let step = 0; step < 5; step++) {
      const before = uri.href(), all = uri.segment(), coded = uri.segmentCoded();
      const context = JSON.stringify({seed, sample, step, input, current: before});
      // The collection APIs are an independent public contract for indexed reads.
      const indexes = [0, -0, -1, all.length - 1, all.length, -all.length,
        -all.length - 1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, next(all.length + 3)];
      for (const index of indexes) {
        const at = index < 0 ? Math.max(0, all.length + index) : index;
        assert.equal(uri.segment(index), all[at], context + ' index=' + index);
        assert.equal(uri.segmentCoded(index), coded[at], context + ' coded index=' + index);
      }
      for (const index of [NaN, Infinity, -Infinity, 0.5, -0.5]) {
        assert.throws(() => uri.segment(index), TypeError, context);
        assert.throws(() => uri.segmentCoded(index), TypeError, context);
      }
      assert.equal(uri.href(), before, context);
      const copy = uri.clone();
      if (!uri.is('urn')) {
        if (step % 2) uri.segment(-1, step % 3 ? 'changed' : null);
        else uri.path('/' + parts.join('/') + '/step-' + step);
      } else uri.href('urn:' + parts.join(':') + ':step-' + step);
      assert.equal(copy.href(), before, context);
    }
  }
});

test.each(seeds)('generated output links open written files (seed %i)', async seed => {
  const next = generator(seed);
  const root = await fs.mkdtemp(join(process.cwd(), '.wse-uri-fuzz-'));
  const pieces = ['%23', '%2F', '%3F', '%25', '%252F', '%255C', '%3A', '%2B',
    '%26', '%20', '汉字', '#hash', '&copy;', '\'quote'];
  const name = (): string => pieces[next(pieces.length)] + pieces[next(pieces.length)];
  try {
    const options = defaultDownloadOptions({...defaultLifeCycle(), localRoot: root});
    const pipeline = new PipelineExecutorImpl(options, options.req, options);
    for (let sample = 0; sample < 24; sample++) {
      const parent = Object.assign(createResource({type: ResourceType.Html, depth: 0,
        url: 'https://example.org/parent', refUrl: 'https://example.org/', localRoot: root,
        savePath: 'example.org/p-' + sample + '-' + name() + '.html'}),
      {body: '', encoding: 'utf8' as const});
      const type = sample % 2 ? ResourceType.Html : ResourceType.Binary;
      const child = Object.assign(createResource({type, depth: 1,
        url: 'https://example.org/child#section', refUrl: parent.url, localRoot: root,
        refSavePath: parent.savePath, savePath: 'example.org/c-' + sample + '-' + name() + '.dat'}),
      {body: 'seed=' + seed + ';sample=' + sample, encoding: 'utf8' as const});
      const document = load('<a id="probe">target</a>');
      document('#probe').attr('href', child.replacePath);
      parent.body = document.html();
      await saveHtmlToDisk(parent, options, pipeline);
      await (type === ResourceType.Html ? saveHtmlToDisk : saveResourceToDisk)(child, options, pipeline);
      const parentFile = join(root, decodeURI(parent.savePath));
      const emitted = load(await fs.readFile(parentFile, 'utf8'))('#probe').attr('href')!;
      const target = new URL(emitted, pathToFileURL(parentFile));
      const context = JSON.stringify({seed, sample, parent: parent.savePath, child: child.savePath, emitted});
      assert.equal(fileURLToPath(target), join(root, decodeURI(child.savePath)), context);
      assert.equal(target.hash, '#section', context);
      assert.equal(await fs.readFile(target, 'utf8'), child.body, context);
    }
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
