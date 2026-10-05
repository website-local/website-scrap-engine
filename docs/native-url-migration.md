# Native URL compatibility migration

The engine replaces URIjs with a Node WHATWG URL adapter. The release version is
not assigned. This remains a breaking migration with best-effort URIjs APIs;
parsing and every historical URIjs quirk are not interchangeable.

## API coverage

```ts
import {URI, NativeUri} from 'website-scrap-engine';

const uri: URI = URI('../image.svg', 'https://example.org/docs/');
const copy: NativeUri = new URI(uri).clone().filename('thumbnail.svg');
const configured = URI({protocol: 'https', hostname: 'example.org', path: '/a'})
  .addQuery('size', [1, 2]).setQuery('format', 'svg');
```

The adapter exposes all **58 core instance method names** in URIjs 1.19.11.
`iso8859()` explicitly throws; the other 57 have best-effort implementations,
including the qualifications below. This count describes the API surface, not
complete overload or behavioral equivalence. Optional URIjs extensions are not
included in that count. The adapter also adds `toJSON()`.

| Group | Methods |
| --- | --- |
| Construction and serialization | Callable `URI`, `new URI`, optional base, parts objects, `clone`, `href`, `toString`, `valueOf`, `toJSON`, `build` |
| Components | `protocol`/`scheme`, `hostname`, `host`, `port`, `username`, `password`, `userinfo`, `authority`, `origin`, `resource`, `path`/`pathname`, `hash`/`fragment` |
| Queries | `query`/`search`, parsed reads, object and callback setters, `addQuery`, `setQuery`, `removeQuery`, `hasQuery`, and corresponding Search aliases |
| Paths | `filename`, `directory`, `suffix`, decoded getters, `segment`, `segmentCoded`, `absoluteTo`, `relativeTo` |
| Normalization | `normalize`, individual protocol/hostname/port/path/query/fragment normalizers and their aliases, `equals` |
| Inspection and configuration | Domain helpers, IP/name predicates, query duplicate/space configuration; limited legacy encoding and validation configuration |

Static utilities include `parse`, `build`, authority/host/userinfo parsers and
builders, `encode`, `decode`, `encodeReserved`, query encoding/parsing/building
and add/set/remove/has helpers, `commonPath`, `joinPaths`, and `withinString`.
Public types include `UriParts`, `UriInput`, `URIConstructor`, `UriPredicate`,
`QueryData`, `QueryInput`, `QuerySetter`, `QueryMatcher`, and `QuerySelector`.

Component setters mutate and return their receiver. Cloning and resolution
return independent instances. `instanceof URI` and `instanceof NativeUri` work;
identity with the third-party URIjs constructor does not. Convert an existing
URIjs instance with `URI(oldUri.toString())` when crossing the migration boundary.
The parts-object constructor is supported; DOM-element construction is not.

## String fields and thread boundaries

The wrapper stores components in ordinary string-named properties, plus boolean
configuration flags and a cached serialized string. It has no JavaScript private
fields, symbols, WeakMap state, or retained native URL object. Native URL objects
are temporary parsing/validation tools. The underscored fields are implementation
details; direct mutation of them can invalidate the cached serialization.

`Resource.uri`, `refUri`, `replaceUri`, and save-path hook contexts expose this
wrapper. Resource structured cloning remains supported, with `normalizeResource`
repairing instances at the boundary. Worker wire encoding continues to send URL
strings and reconstruct runtime wrappers. Clones share no mutable parsed URL.

## Parsing and output differences

Absolute construction and resolution retain WHATWG semantics:

| Input | Result or consequence |
| --- | --- |
| `https://EXAMPLE.org:443/a` | `https://example.org/a`; host case and default ports canonicalize |
| Unicode hostname/path | Host becomes Punycode; path becomes percent-encoded |
| `/a/%2e%2e/b` against an HTTPS base | Resolves to `/b` before save-path generation |
| `https://bad host/a` or `http:///` | Constructor rejects, including when `skipReplacePathError` is enabled |
| Empty query/fragment delimiters | Absolute serialization can retain `?` and `#` |
| A hostless relative/file reference changed to an HTTP scheme | Native reparsing may infer a host or reject; it does not preserve URIjs's malformed hostless HTTP spelling |

Canonical spelling defines resource URLs and deduplication. `rawUrl` preserves
the original source. Output filenames and deduplication keys can therefore
change; existing output trees should be rebuilt. Local-mount containment checks
also inspect original source spelling so parsing cannot hide encoded traversal.

Relative references retain a lexical representation without a placeholder
origin. `relativeTo` generates local links for compatible hierarchical URLs;
different origins, Windows drives, or repeated path separators can retain an
absolute target. First-segment colons are protected with `./`.
`absoluteTo` requires an absolute base accepted by native `URL`; URIjs also
accepts relative bases. `relativeTo` retains the input when either reference
lacks a scheme, and retains the full absolute URL when authority or credentials
differ, where URIjs may emit a scheme-relative reference.

## Query compatibility

Unmodified raw query strings retain their spelling through reads and unrelated
mutations. Explicit object/callback setters use URIjs-style query policy:

- `null` produces a bare key; `undefined` is omitted.
- Repeated identical object values are deduplicated by default;
  `duplicateQueryParameters(true)` retains them.
- Spaces become `+` by default; `escapeQuerySpace(false)` uses `%20`.
- Parsed bare keys are `null`, repeated values are arrays, malformed escapes
  remain undecoded, and `__proto__` keys are ignored.
- Name-only `hasQuery`/`hasSearch` checks match actual query keys. Inherited names
  such as `constructor` do not count unless present in the query, unlike URIjs's
  inherited-property lookup. Existence checks decode keys without parsing values.
- `query(true)`/`search(true)` parse; `query(false)`/`search(false)` clear.
- Callback setters receive parsed data with the URI as `this`.

`query(callback)` can group several edits into one parse/build cycle. It is not
universally interchangeable with helper chains: chains normalize after every
edit. For example, setting `x` to `[null, 'null']` and then adding `'new'` produces
`x=new` through chained helpers and `x&x=new` when those static helpers run in one
callback. Both results agree with URIjs for their respective forms.

These rules supersede the first wrapper's URLSearchParams-based setter behavior.
Crawler query ordering, short-query escaping and long-query hashing remain
separate policies. `normalize()` now includes component/query normalization;
`equals()` compares normalized URLs and tolerates query ordering differences.

The MDN artifact/log probe additionally hardened explicit path normalization and
path-component setters. Normalization recodes parentheses and other non-path
characters; filename, directory and suffix setters recode their replacement,
while segment setters recode the resulting path. Untouched components retain
their spelling. `readable()` removes credentials and decodes components
separately, preserving encoded path separators and query ampersands. Repeated
leading fragment hashes survive normalization. See the
[corpus probe and performance report](mdn-uri-probe.md).

## Best-effort limits

- Domain/TLD helpers use label splitting, without URIjs's second-level-domain
  database. They do not determine registrable domains: for `a.example.co.uk`,
  `domain()` returns `co.uk`, not `example.co.uk`. `is('sld')` returns false.
- `is('idn')` inspects stored spelling; native Punycode normalization means an
  initially Unicode hostname normally reports `punycode`, not `idn`.
- Native validation remains enabled even after `preventInvalidHostname(false)`.
  The flag does not restore URIjs's permissive malformed-host parser.
- UTF-8 is the only encoding mode. `unicode()` selects that existing behavior;
  `iso8859()` throws. `readable()` is a display helper, not a round-trip URL format.
  It retains the native scheme form for opaque URLs and the `//` prefix of
  scheme-relative references, unlike URIjs's display quirks. Fragment
  normalization decodes percent-encoded unreserved characters; URIjs leaves
  nonempty fragments unchanged.
- Opaque URL path/authority mutations remain unsupported. Credentials require
  a network authority and use native escaping.
  Opaque paths retain native spelling, including data-URL slashes; decoded
  segment getters tolerate malformed escapes. URIjs may recode those paths or
  throw instead. Its opaque decoded filename/directory receiver-return quirk is
  not reproduced: wrapper getters keep their string return type.
- Relative path setters retain lexical spelling and do not reproduce all of
  URIjs's path recoding. Resolve against an absolute base for native escaping.
- `build` accepts the legacy argument but serialization is lazily cached; its
  internal scheduling and private URIjs representation are not reproduced.
- `withinString` provides basic scheme-URL scanning, without URIjs's full HTML,
  punctuation, parentheses and scanning-option behavior.
- URI templates, fragment-query/fragment-URI extensions, jQuery integration,
  browser globals, DOM inputs, undocumented internals, and all obscure setter
  coercions are outside this adapter.

## Consumer migration and validation

The [upstream regression fixtures](../test/fixtures/urijs/README.md) add 182
assertions from URIjs 1.19.11 query/RFC suites and 48 original resolution vectors.
Known native differences are asserted separately from upstream equivalence.
The earlier 116/118 extension matrix describes that selected corpus only;
neither it nor method-name coverage implies complete URIjs suite compatibility.

Replace direct URIjs imports in hooks with the engine's `URI` import, including
type imports. The separate 0.10 save-path hook migration still applies. The
[MDN migration patch](mdn-native-url-migration.patch) targets MDN-local
`a4979c82eaec38c9cdb385a0e15e4512dd3a5fc0`; its isolated consumer type-checks with
the expanded wrapper. The neighboring MDN checkout was not changed. Consumers
must update the engine dependency, remove direct URIjs/type dependencies, and
install `log4js` if using MDN's logger.

The expanded wrapper passes 571 tests in 46 suites, lint, strict test types,
build, installed-consumer checks, and native Windows runtime checks. The
existing 6,000-case canonical corpus matches URIjs. Additional compatibility
cases and native setter checks cover the new functions and mutation fast paths.
See the [extension report](uri-extended-performance.md) for exact evidence and
remaining semantic differences.

Validation artifacts are under `/mnt/e/tmp/wse-uri-extended-20261005`. Build/tests
use an isolated snapshot excluding the unrelated untracked
`src/shared-context.ts` draft; tested formatting is copied back. No new tracked
dependency was introduced, and Cheerio remains unchanged.

Earlier whole-crawl results and the initial direct API campaign remain historical
measurements in [native-url-performance.md](native-url-performance.md) and
[uri-direct-performance.md](uri-direct-performance.md). This extension's profiling
and direct-call measurements are separate; no accepted engine campaign is rerun.
