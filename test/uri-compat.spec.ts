import {describe, expect, test} from '@jest/globals';
import URI, {type QueryData, type UriPredicate} from '../src/uri.js';

describe('URIjs compatibility functions', () => {
  test('URI predicates distinguish references, opaque schemes, domains and IP families', () => {
    const kinds: UriPredicate[] = ['relative', 'absolute', 'url', 'urn', 'domain', 'name', 'sld',
      'ip', 'ip4', 'ipv4', 'inet4', 'ip6', 'ipv6', 'inet6', 'idn', 'punycode'];
    for (const [input, matched] of [
      ['../asset', ['relative', 'url']],
      ['https://example.org/a', ['absolute', 'url', 'domain', 'name']],
      ['mailto:user@example.org', ['absolute', 'urn']],
      ['https://127.0.0.1/', ['absolute', 'url', 'ip', 'ip4', 'ipv4', 'inet4']],
      ['https://[::1]/', ['absolute', 'url', 'ip', 'ip6', 'ipv6', 'inet6']],
      ['https://例子.测试/', ['absolute', 'url', 'domain', 'name', 'punycode']],
    ] as const) {
      const uri = URI(input);
      for (const kind of kinds) {
        expect(uri.is(kind)).toBe((matched as readonly string[]).includes(kind));
        expect(uri.is(kind.toUpperCase() as UriPredicate)).toBe(uri.is(kind));
      }
    }
  });

  test('constructor bases use current serialized state and preserve input flags', () => {
    const base = URI('https://example.org/a/index.html?old#part').path('/b/index.html');
    for (const input of ['../asset', {path: '../asset'}, URI('../asset')
      .escapeQuerySpace(false).duplicateQueryParameters(true), new URL('https://other.org/resource')]) {
      for (const baseInput of [base, base.href(), new URL(base.href()),
        {protocol: 'https', hostname: 'example.org', path: '/b/index.html'},
        Object.assign(Object.create(URI.prototype), structuredClone(base))]) {
        const uri = URI(input, baseInput);
        expect(uri.href()).toBe(input instanceof URL ? 'https://other.org/resource' : 'https://example.org/asset');
        uri.query({x: ['a b', 'a b']});
        expect(uri.query()).toBe(input instanceof URI ? 'x=a%20b&x=a%20b' : 'x=a+b');
        expect(base.href()).toBe('https://example.org/b/index.html?old#part');
        if (input instanceof URI) expect(input.href()).toBe('../asset');
      }
    }
  });

  test('query existence handles decoded keys, separators, flags and prototype names', () => {
    const uri = URI('?&&a+b=1&%E6%BC%A2%E5%AD%97=2&=empty&flag&bad%ZZ+key=3&constructor=ok&%5f%5fproto%5f%5f=bad');
    for (const name of ['a b', '漢字', '', 'flag', 'bad%ZZ+key', 'constructor']) {
      expect(uri.hasQuery(name)).toBe(true);
      expect(uri.hasSearch(name, undefined, true)).toBe(true);
    }
    for (const name of ['__proto__', 'a+b', 'missing', 'hasOwnProperty', 'bad%ZZ key']) expect(uri.hasQuery(name)).toBe(false);
    uri.escapeQuerySpace(false);
    expect(uri.hasQuery('a+b')).toBe(true);
    expect(uri.hasQuery('a b')).toBe(false);
    expect(URI('?&&').hasQuery('')).toBe(false);
    expect(URI('???flag&x==value').hasQuery('flag')).toBe(true);
    expect(URI('???flag&x==value').hasQuery('x')).toBe(true);
    const flags = Array.from({length: 2000}, (_, i) => 'flag' + i).join('&');
    const many = URI('?' + flags + '&tail=1');
    expect(many.hasQuery('flag1999')).toBe(true);
    expect(many.hasQuery('tail')).toBe(true);
    expect(many.hasQuery('missing')).toBe(false);
    const snapshot = uri.href();
    expect(uri.hasQuery('constructor', value => value === 'ok')).toBe(true);
    expect(uri.hasQuery(/^construct/)).toBe(true);
    expect(uri.hasQuery({flag: null})).toBe(true);
    expect(uri.href()).toBe(snapshot);
  });

  test('encoded object writes preserve delimiters, errors and serialized mutations', () => {
    for (const base of ['https://example.org/a', '//example.org/a', 'file:///a', 'custom:/a', 'mailto:a', '../a', '']) {
      const uri = URI(base + '?old=1#part');
      const data = {'? #\u0000': '漢字 +%\'"<>', flag: null};
      const query = '%3F+%23%00=%E6%BC%A2%E5%AD%97+%2B%25%27%22%3C%3E&flag';
      expect(uri.query(data)).toBe(uri);
      expect(uri.href()).toBe(base + '?' + query + '#part');
      expect(uri.query(data).hash('next').href()).toBe(base + '?' + query + '#next');
      const saved = uri.href();
      expect(() => uri.query({x: '\ud800'})).toThrow(URIError);
      expect(uri.href()).toBe(saved);
      expect(() => uri.query(() => { throw new Error('callback'); })).toThrow('callback');
      expect(uri.href()).toBe(saved);
      expect(uri.query(null).href()).toBe(base + '#next');
      expect(uri.search('?').query({}).href()).toBe(base + '#next');
    }
  });

  test('base reuse resolves current state and produces independent results', () => {
    const base = URI('https://user:pass@example.org/a/index.html?old=1#part');
    base.href();
    base.path('/b/index.html').query({new: '2'});
    const ref = URI('../asset.css');
    const expected = 'https://user:pass@example.org/asset.css';
    for (const input of [base, base.href(), new URL(base.href()), {
      protocol: 'https', username: 'user', password: 'pass', hostname: 'example.org', path: '/b/index.html',
    }, Object.assign(Object.create(URI.prototype), structuredClone(base))]) {
      const result = ref.absoluteTo(input);
      expect(result.href()).toBe(expected);
      result.path('/changed');
      expect(ref.href()).toBe('../asset.css');
      expect(base.href()).toBe('https://user:pass@example.org/b/index.html?new=2#part');
    }
    expect(base.absoluteTo(base).href()).toBe(base.href());
    expect(URI('?').absoluteTo(base).href()).toBe('https://user:pass@example.org/b/index.html?');
    expect(URI('#').absoluteTo(base).href()).toBe('https://user:pass@example.org/b/index.html?new=2#');
  });

  test('batch edits match the benchmark chain while intermediate normalization remains observable', () => {
    for (const duplicates of [false, true]) for (const spaces of [false, true]) {
      const uri = URI('?x=1&x=2&flag').duplicateQueryParameters(duplicates).escapeQuerySpace(spaces);
      const chain = uri.clone().addQuery('x', '3').setQuery('new', 'a b').removeQuery('x', '1');
      uri.query(data => {
        URI.addQuery(data, 'x', '3');
        URI.setQuery(data, 'new', 'a b');
        URI.removeQuery(data, 'x', '1');
      });
      expect(uri.href()).toBe(chain.href());
    }
    const chain = URI('').setQuery('x', [null, 'null']).addQuery('x', 'new');
    const batch = URI('').query(data => {
      URI.setQuery(data, 'x', [null, 'null']);
      URI.addQuery(data, 'x', 'new');
    });
    expect(chain.query()).toBe('x=new');
    expect(batch.query()).toBe('x&x=new');
  });

  test('constructs from parts, a base, and independent copies', () => {
    const uri = URI({protocol: 'https', hostname: 'example.org', path: '/a', query: {x: 1}});
    expect(uri.href()).toBe('https://example.org/a?x=1');
    expect(URI('../b', uri).href()).toBe('https://example.org/b');
    const copy = new URI(uri).filename('other');
    expect(copy.href()).toBe('https://example.org/other?x=1');
    expect(uri.href()).toBe('https://example.org/a?x=1');
    expect(URI('b').absoluteTo({protocol: 'https', hostname: 'example.org', path: '/a/'}).href())
      .toBe('https://example.org/a/b');
  });

  test('ordinary stored fields are cloneable and contain no native URL objects', () => {
    const uri = URI('https://user:pass@example.org:8080/a?x=1#part');
    const clone = structuredClone(uri);
    expect(Object.getOwnPropertySymbols(uri)).toEqual([]);
    expect(Object.values(clone).every(value => value === undefined ||
      typeof value === 'string' || typeof value === 'boolean')).toBe(true);
    expect(Object.assign(Object.create(URI.prototype), clone).href()).toBe(uri.href());
    expect(uri.clone().port(9000).username('other').href())
      .toBe('https://other:pass@example.org:9000/a?x=1#part');
    expect(uri.port()).toBe('8080');
  });

  test('credential, origin, resource and scheme accessors remain chainable', () => {
    const uri = URI('https://example.org/a').userinfo('user:pass');
    expect(uri.authority()).toBe('user:pass@example.org');
    expect(uri.origin()).toBe('https://user:pass@example.org');
    uri.origin('http://other:secret@other.org:8080').resource('/b?q=1#part');
    expect(uri.href()).toBe('http://other:secret@other.org:8080/b?q=1#part');
    expect(uri.resource()).toBe('/b?q=1#part');
    expect(uri.scheme()).toBe('http');
  });

  test('rejects invalid mutations without changing the URI', () => {
    const uri = URI('https://example.org/a');
    for (const change of [() => uri.hostname('bad host'), () => uri.hostname('example.0x1'), () => uri.port(65536),
      () => uri.protocol('bad:' + '/'), () => uri.authority('other.org/path')]) {
      expect(change).toThrow();
      expect(uri.href()).toBe('https://example.org/a');
    }
  });

  test('fast component mutation agrees with native canonicalization', () => {
    for (const hostname of ['Example.COM', 'host-name.test', 'foo_bar.test',
      '127.1', '0x7f.1', '[::1]', '例子.测试']) {
      const expected = new URL('https://example.org:8080/a');
      expected.hostname = hostname;
      const actual = URI('https://example.org:8080/a').hostname(hostname);
      expect(actual.href()).toBe(expected.href);
    }
    for (const path of ['/static/a.svg', '/a/../b', '/a/%2e%2e/b',
      '/a//b', '/with space', '/a?b#c', '/路径', '/a\\b']) {
      const expected = new URL('https://example.org/a?x=1#part');
      expected.pathname = path;
      expect(URI('https://example.org/a?x=1#part').path(path).href()).toBe(expected.href);
    }
    expect(URI('https://example.org:80/a').protocol('http').port()).toBe('');
    for (const base of ['//example.org/a', 'custom://example.org/a', 'constructor://example.org/a']) {
      const uri = URI(base).path('');
      expect(uri.href()).toBe(base.slice(0, -2));
      expect(uri.hostname('UPPER.example').hostname()).toBe('UPPER.example');
    }
  });

  test('queries preserve bare keys and deduplicate object values by default', () => {
    const uri = URI('?x=1&x=2&flag&empty=&bad=%ZZ');
    expect(uri.query(true)).toEqual({x: ['1', '2'], flag: null, empty: '', bad: '%ZZ'});
    expect(uri.query({x: ['1', '1', '2'], flag: null, empty: '', skip: undefined}).search())
      .toBe('?x=1&x=2&flag&empty=');
    expect(uri.query(false)).toBe(uri);
    expect(uri.query()).toBe('');
  });

  test('query callback, instance flags and aliases work on independent clones', () => {
    const uri = URI('?a=1').escapeQuerySpace(false).duplicateQueryParameters(true);
    uri.query(function (data) { expect(this).toBe(uri); data.a = ['a b', 'a b']; });
    expect(uri.query()).toBe('a=a%20b&a=a%20b');
    expect(uri.clone().scheme('').query({x: ['x y', 'x y']}).query()).toBe('x=x%20y&x=x%20y');
    expect(uri.search(true)).toEqual({a: ['a b', 'a b']});
    expect(uri.search(false).search()).toBe('');
  });

  test('adds, replaces, matches and removes query parameters', () => {
    const uri = URI('?x=1').addQuery('x', ['2', '3']).setSearch('flag');
    expect(uri.hasQuery('x', '2')).toBe(false);
    expect(uri.hasQuery('x', '2', true)).toBe(true);
    expect(uri.hasSearch({x: ['3', '1', '2']})).toBe(true);
    expect(uri.hasQuery('flag', false)).toBe(true);
    uri.removeQuery('x', /[13]/).addSearch({y: '4'}).removeSearch(/^flag/);
    expect(uri.query()).toBe('x=2&y=4');
    expect(uri.hasQuery('y', value => value === '4')).toBe(true);
  });

  test('query statics avoid prototype mutation and honor encoding options', () => {
    expect(URI.parseQuery('__proto__=bad&constructor=ok')).toEqual({constructor: 'ok'});
    const data = URI.parseQuery('x=1');
    URI.addQuery(data, 'x', '2');
    URI.setQuery(data, 'flag', null);
    URI.removeQuery(data, 'x', '1');
    expect(URI.buildQuery(data)).toBe('x=2&flag');
    expect(URI.buildQuery({x: ['a b', 'a b']}, true, false)).toBe('x=a%20b&x=a%20b');
    expect(URI.encode('~!*\'()')).toBe('~%21%2A%27%28%29');
    expect(URI.decodeQuery('%ZZ+value')).toBe('%ZZ+value');
  });

  test('query fast paths preserve escaping, malformed input and value distinctions', () => {
    expect(URI.encode('Az09-._~')).toBe('Az09-._~');
    expect(URI.encodeQuery('汉字 /? !*\'()', true))
      .toBe('%E6%B1%89%E5%AD%97+%2F%3F+%21%2A%27%28%29');
    expect(URI.encodeQuery('a b+c', false)).toBe('a%20b%2Bc');
    expect(() => URI.encode('\ud800')).toThrow(URIError);
    expect(URI.decodeQuery('a+b', true)).toBe('a b');
    expect(URI.decodeQuery('a+b', false)).toBe('a+b');
    expect(URI.decodeQuery('%2B+%20', true)).toBe('+  ');
    for (const value of ['%ZZ+value', '%ED%A0%80+x', '%E0%A4+A', '%+']) {
      expect(URI.decodeQuery(value)).toBe(value);
    }
    expect(URI.buildQuery({x: [null, 'null', 0, '0', false, 'false', undefined], empty: '', flag: null}))
      .toBe('x&x=0&x=false&empty=&flag');
    expect(URI.buildQuery({x: [null, 'null', 0, '0', false, 'false', undefined]}, true))
      .toBe('x&x=null&x=0&x=0&x=false&x=false');
    const inherited = Object.assign(Object.create({ignored: 'value'}), {'': '', flag: null, skip: undefined});
    expect(URI.buildQuery(inherited)).toBe('=&flag');
  });

  test('query scanning preserves separators, empty keys and embedded equals signs', () => {
    expect(URI.parseQuery('???&&flag&x=a=b&&=empty-key&x=last&flag=&%5F%5Fproto%5F%5F=ignored&'))
      .toEqual({flag: [null, ''], x: ['a=b', 'last'], '': 'empty-key'});
    expect(URI.parseQuery('a&b&c=1&d&e=2=3&f')).toEqual({a: null, b: null, c: '1', d: null, e: '2=3', f: null});
    expect(URI.parseQuery('??&?flag&x=+%ZZ&y=%2B+', false))
      .toEqual({'?flag': null, x: '+%ZZ', y: '++'});
    expect(URI.parseQuery('???&&')).toEqual({});
    const bare = Array.from({length: 2000}, (_, i) => 'flag' + i);
    expect(Object.keys(URI.parseQuery(bare.join('&')))).toEqual(bare);
    expect(URI.parseQuery(bare.join('&') + '&tail=1').tail).toBe('1');
    const uri = URI('?x=1&x=2');
    const first = uri.query(true);
    (first.x as string[]).push('3');
    expect(uri.query(true).x).toEqual(['1', '2']);
  });

  test('small and large query arrays share deduplication and sparse-value behavior', () => {
    for (const {values, expected} of [
      {values: [], expected: ''}, {values: ['a'], expected: 'x=a'},
      {values: ['a', 'a'], expected: 'x=a'}, {values: ['a', 'b'], expected: 'x=a&x=b'},
      {values: ['a', 'b', 'a'], expected: 'x=a&x=b'}, {values: [null, 'null'], expected: 'x'},
      {values: [undefined, 'undefined'], expected: 'x=undefined'},
      {values: [false, 'false'], expected: 'x=false'}, {values: [0, '0'], expected: 'x=0'},
      {values: Array.from({length: 64}, (_, i) => 'value' + i % 8),
        expected: 'x=value0&x=value1&x=value2&x=value3&x=value4&x=value5&x=value6&x=value7'},
    ]) {
      expect(URI.buildQuery({x: values})).toBe(expected);
    }
    const sparse = new Array<string>(2);
    sparse[1] = 'last';
    expect(URI.buildQuery({x: sparse})).toBe('x=last');
    expect(URI.buildQuery({x: [null, 'null']}, true)).toBe('x&x=null');
  });

  test('query encoding fast return honors space mode and encoded percent sequences', () => {
    for (const spaces of [true, false]) {
      expect(URI.encodeQuery('Az09-._~', spaces)).toBe('Az09-._~');
      expect(URI.encodeQuery('%20+%2520', spaces)).toBe('%2520%2B%252520');
      expect(URI.encodeQuery('\u00a0', spaces)).toBe('%C2%A0');
      expect(URI.encodeQuery('a b', spaces)).toBe(spaces ? 'a+b' : 'a%20b');
      expect(() => URI.encodeQuery('\ud800', spaces)).toThrow(URIError);
    }
  });

  test('query helpers retain normalized values across successive edits', () => {
    const uri = URI('?flag&x=1&x=1').setQuery('number', 42).addQuery('x', ['2', '2']);
    expect(uri.query(true)).toEqual({flag: null, x: ['1', '2'], number: '42'});
    uri.setQuery('bool', false).removeQuery('x', '1');
    expect(uri.query(true)).toEqual({flag: null, x: '2', number: '42', bool: 'false'});
    expect(uri.query()).toBe('flag&x=2&number=42&bool=false');
    uri.setQuery('', null).setQuery('skip', undefined);
    expect(uri.query(true)).toEqual({flag: null, x: '2', number: '42', bool: 'false', skip: null});
    expect(URI('').setQuery('', null).query(true)).toEqual({});
    expect(URI('').setQuery('', '').addQuery('x', '1').query(true)).toEqual({'': '', x: '1'});
  });

  test('parsed query results and matcher callbacks remain independent', () => {
    const uri = URI('').setQuery('x', ['1', '2']);
    const parsed = uri.query(true);
    (parsed.x as string[]).push('external');
    parsed.other = 'external';
    uri.hasQuery('x', (_value, _name, data) => { data.x = ['changed']; return true; });
    expect(uri.query(true)).toEqual({x: ['1', '2']});
    uri.addQuery('x', '3');
    expect(uri.query()).toBe('x=1&x=2&x=3');
    let captured: QueryData | undefined;
    uri.query(data => { captured = data; data.x = 'callback'; });
    captured!.x = 'external';
    expect(uri.query(true)).toEqual({x: 'callback'});
  });

  test('query helper chains respect encoding and duplicate-mode changes', () => {
    const uri = URI('').setQuery('x', 'a b');
    expect(uri.query()).toBe('x=a+b');
    expect(uri.escapeQuerySpace(false).query(true)).toEqual({x: 'a+b'});
    uri.addQuery('y', 'c d');
    expect(uri.query()).toBe('x=a%2Bb&y=c%20d');
    uri.escapeQuerySpace(true).duplicateQueryParameters(true).setQuery('x', ['1', '1']);
    expect(uri.query(true).x).toEqual(['1', '1']);
    expect(uri.duplicateQueryParameters(false).query(true).x).toEqual(['1', '1']);
    uri.setQuery('next', 'value');
    expect(uri.query(true).x).toBe('1');
  });

  test('query replacements and native reloading are observed by later helpers', () => {
    const uri = URI('https://example.org/a').setQuery('old', ['1', '2']);
    uri.search('raw=a+b&raw=2').addQuery('raw', '3');
    expect(uri.query(true)).toEqual({raw: ['a b', '2', '3']});
    uri.username('user').setQuery('fresh', '4');
    expect(uri.query(true)).toEqual({raw: ['a b', '2', '3'], fresh: '4'});
    uri.href('https://other.org/?new=1').addQuery('new', '2');
    expect(uri.query(true)).toEqual({new: ['1', '2']});
    uri.query({object: 7}).addQuery('object', '8');
    expect(uri.query(true)).toEqual({object: ['7', '8']});
    expect(uri.query(false).addQuery('last', '9').query(true)).toEqual({last: '9'});
  });

  test('failed helper encoding preserves the preceding query', () => {
    const uri = URI('?x=1').addQuery('x', '2');
    const before = uri.href();
    for (const change of [() => uri.setQuery('x', '\ud800'), () => uri.addQuery('\ud800', '3')]) {
      expect(change).toThrow(URIError);
      expect(uri.href()).toBe(before);
      expect(uri.query(true)).toEqual({x: ['1', '2']});
    }
    uri.addQuery('x', '3');
    expect(uri.query(true)).toEqual({x: ['1', '2', '3']});
  });

  test('query removal preserves static array shape and scalar matching rules', () => {
    const data = {x: ['1', '2'], scalar: '1', flag: null, missing: undefined};
    URI.removeQuery(data, 'x', '1');
    expect(data.x).toEqual(['2']);
    URI.removeQuery(data, 'scalar', []);
    expect(data.scalar).toBe('1');
    URI.removeQuery(data, 'scalar', /^1$/g);
    URI.removeQuery(data, 'flag', [null]);
    URI.removeQuery(data, 'missing', 'unused');
    expect(data).toEqual({x: ['2']});
    expect(URI('?x=1&x=2&x=3').removeQuery('x', /[13]/g).query(true)).toEqual({x: '2'});
  });

  test('helper edits preserve independent clones and structured-clone restoration', () => {
    const uri = URI('https://example.org/a').addQuery('x', ['1', '2']);
    const copy = uri.clone().addQuery('x', '3');
    const restored = Object.assign(Object.create(URI.prototype), structuredClone(uri)) as typeof uri;
    restored.removeQuery('x', '1').setQuery('other', '4');
    expect(copy.query(true)).toEqual({x: ['1', '2', '3']});
    expect(restored.query(true)).toEqual({x: '2', other: '4'});
    expect(uri.query(true)).toEqual({x: ['1', '2']});
    expect(Object.getOwnPropertySymbols(uri)).toEqual([]);
  });

  test('hostname validation retains native fallbacks and mutation atomicity', () => {
    const base = 'https://user:pass@example.org:8080/a?x=1#h';
    for (const hostname of ['CDN-9.Example.ORG', '_srv.example', 'a.b.c.',
      '127.1', '0x7f.1', '2130706433', '0177.0.0.1', '例子.测试', 'xn--bcher-kva.de', '[::1]']) {
      const expected = new URL(base);
      expected.hostname = hostname;
      expect(URI(base).hostname(hostname).href()).toBe(expected.href);
    }
    for (const hostname of ['example.123', 'example.0xff', 'example.0xff.', 'xn--', 'bad host', '%ZZ']) {
      const uri = URI(base);
      expect(() => uri.hostname(hostname)).toThrow();
      expect(uri.href()).toBe(base);
    }
    expect(URI('custom://example.org/a').hostname('UPPER.Example').hostname()).toBe('UPPER.Example');
  });

  test.each(['https://user:pass@example.org:8080/a', '//example.org/a',
    'file:///C:/a', 'custom:/a', 'mailto:user@example.org'])(
    'component loading retains empty delimiters for %s', base => {
      for (const tail of ['', '?', '#', '?#', '?#part?', '#?', '?x=1#', '?x=1#?']) {
        const input = base + tail;
        const uri = URI(input);
        expect(uri.clone().build().href()).toBe(input);
        const native = new URL(base.startsWith('//') ? 'https:' + input : input);
        const fromNative = URI(native);
        expect(fromNative.build().href()).toBe(native.href);
        expect(fromNative.search()).toBe(native.search);
        expect(fromNative.hash()).toBe(native.hash);
      }
    });

  test('segments support decoded reads, index replacement, append and deletion', () => {
    const uri = URI('https://example.org/a/with%20space/');
    expect(uri.segment()).toEqual(['a', 'with%20space', '']);
    expect(uri.segmentCoded(1)).toBe('with space');
    uri.segmentCoded(-1, 'slash/in-name').segment(0, null);
    expect(uri.path()).toBe('/with%20space/slash%2Fin-name');
    expect(uri.segment(99)).toBeUndefined();
    expect(URI('a/b').segment(['x', 'y']).segment('z').path()).toBe('x/y/z');
  });

  test('normalization and equality handle query order without mutating inputs', () => {
    const uri = URI('https://example.org/a?x=1&x=2&y=a%20b#%70art');
    expect(uri.equals('https://example.org/a?y=a+b&x=2&x=1#part')).toBe(true);
    expect(uri.href()).toBe('https://example.org/a?x=1&x=2&y=a%20b#%70art');
    expect(URI('?flag').equals('?flag=')).toBe(false);
    expect(URI('a/../b').normalizePathname().path()).toBe('b');
  });

  test('supports basic domain and IP inspection without claiming a suffix database', () => {
    const uri = URI('https://www.example.org/a');
    expect([uri.subdomain(), uri.domain(), uri.tld()]).toEqual(['www', 'example.org', 'org']);
    expect(uri.subdomain('cdn').domain('example.net').tld('com').hostname()).toBe('cdn.example.com');
    expect(URI('https://[::1]/').is('ipv6')).toBe(true);
    expect(URI('https://127.0.0.1/').is('ip')).toBe(true);
    expect(URI('https://例子.测试/').is('punycode')).toBe(true);
    expect(() => uri.iso8859()).toThrow('not supported');
  });

  test('static parts and path utilities produce usable references', () => {
    const parts = {protocol: 'https', hostname: 'example.org', path: '/a', query: 'x=1'};
    expect(URI.build(parts)).toBe('https://example.org/a?x=1');
    expect(URI.parse(URI.build(parts))).toMatchObject(parts);
    expect(URI.buildHost({hostname: '::1', port: 8080})).toBe('[::1]:8080');
    expect(URI.joinPaths('/a/', 'b', '../c').path()).toBe('/a/c');
    expect(URI.commonPath('/a/b', '/a/c')).toBe('/a/');
    expect(URI.withinString('go https://example.org/a now', url => URI(url).filename('b').href()))
      .toBe('go https://example.org/b now');
  });
});
