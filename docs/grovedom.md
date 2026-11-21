# Application-selected GroveDOM

Cheerio is the default parser. To use GroveDOM, import and initialize it in the
application's options module and provide a synchronous `loadHtml` callback.
The engine does not manage parser modules or pools. Each processing worker
loads the same options module and initializes its own parser.

```ts
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {init, load} from 'grovedom';
import {lifeCycle, options} from 'website-scrap-engine';
import type {HtmlParserOptions} from 'website-scrap-engine';

const require = createRequire(import.meta.url);
const entry = require.resolve('grovedom');
init({wasm: resolve(dirname(entry), '../grovedom.wasm'),
  heap: 'pool', poolSize: 4, poolMaxBytes: 8 * 1024 * 1024});

// Check application hooks against the selected parser. The engine's hook
// declarations retain the Cheerio shape; this assertion does not prove parity.
const loadHtml = load as unknown as HtmlParserOptions['loadHtml'];
export default options.defaultDownloadOptions({
  ...lifeCycle.defaultLifeCycle(), loadHtml,
  localRoot: './output', initialUrl: ['https://example.com/']
});
```

Do not pass the loader in static downloader overrides: functions cannot be
structured-cloned into a worker. Parser initialization, memory limits and pool
sizing belong to the application. Passing `undefined` selects default Cheerio.
`cheerioParse` and `cheerioSerialize` remain explicit options forwarded by the
engine; a replacement parser must support the options the application uses.

For downloader submissions, managed document ownership begins when a resource enters
`downloadAndProcessResource`. During that processing, default save/discard/failure
paths dispose `meta.doc` after pending status observers finish. Nested
HTML/SVG/sitemap loads use the selected loader and release their own documents.
Hooks replacing a document must keep resource ownership intact; do not retain
selections after their document has been disposed.

A caller-created document attached before processing remains the caller's
responsibility while its resource is queued. Submitting to the downloader does
not transfer ownership on admission. Duplicate or depth rejection, submission
during shutdown, and an entry removed by `queue.clear()` or `downloader.dispose()`
leave that unprocessed document with the caller. If execution never begins, the
caller must release it. Once execution begins, let the active pipeline release
it; resubmitting the same active resource does not grant another ownership claim.
Calling lifecycle/parser helpers directly still follows their existing cleanup
contract; a helper may dispose a discarded or replaced document before admission.

Prefer submitting HTML in `resource.body` with no `meta.doc`, then let the default
HTML processing hook call the application's `loadHtml`. For example, given an
initialized downloader:

```ts
import {resource} from 'website-scrap-engine';

const url = 'https://example.com/page.html';
const page = downloader.pipeline.createResource(resource.ResourceType.Html, 0, url, url);
page.body = '<html><head></head><body>Local content</body></html>';
downloader.addProcessedResource(page);
```

Use the same body-only form with a lifecycle `submit(child)` callback. Put custom
DOM creation or mutation in the active resource's `processAfterDownload` hooks,
after the built-in HTML hook when reusing `meta.doc`. Do not preparse documents in
`processBeforeDownload` merely to enqueue them. Worker submissions carry body
and cloneable metadata; live documents stay in the worker that created them.

This admission boundary matches 0.9.1's treatment of caller-created documents.
It changes the broader admission cleanup contract of earlier unpublished 0.10
builds. Keeping document creation inside active processing avoids an ownership
registry or document checks on every admission, with zero additional work on
the default queue path. Applications needing precreated queued documents must
provide their own opt-in ownership and rejection/cancellation cleanup.

GroveDOM 0.1.3's `loadFast` is an explicit alternative to `load`. Fast selections
need `.eq(index)` instead of numeric selection indexing. Audit application
hooks, returned node types and parser/serializer options before selecting it.
An assertion to `HtmlParserOptions['loadHtml']` is only a TypeScript boundary.

## Compatibility and development checks

Keep parser selection explicit. Older 0.1.0/0.1.1 adapters and their registry,
module-resolution and pool-management machinery are superseded by the supplied
loader contract above. Application initialization and each worker own their
parser settings; a retained idle-pool byte limit is not a cap on active documents
or total process memory. Check cold startup, nested loads and multiple workers.

Historical published-0.1.1 validation matched 193 selected transformation cases,
disposed all 303 documents, and matched 32 saved-file/link probes. It did not
qualify whole-crawl speed or sustained memory. Tested htmlparser2 alternatives
changed 163–166 of those 193 outputs, so parser substitution must compare actual
serialization, discoveries and saved links. Earlier 0.1.1 selector, option and
cross-document node-ownership differences are reasons to audit the installed
parser; they are not claims about every newer version.

Current runtime checks cover both downloader modes, nested documents, successful
save, discard, processing/save failure, replacement ownership and pending status
observers. Run the packed consumer with an application-installed parser:

```sh
node scripts/check-consumer.mjs /path/to/consumer --grovedom
```

The engine does not promise arbitrary Cheerio/domhandler/plugin compatibility.
Validate the application's hooks, serialization options, node operations and
parser version. Keep fixture correctness separate from timing, archive/browser
coverage and sustained memory. See the [0.10 design guide](0.10-design.md) for
the engine's performance policy and current qualification.
