# URIjs 1.19.11 upstream regression fixtures

Source: https://github.com/medialize/URI.js/tree/v1.19.11/test
License: MIT, reproduced in `LICENSE.txt`.

`query-tests.json` contains 16 upstream test callbacks (182 assertions) from
`test.js` and `test_jim.js`: the complete "mutating query strings" group, basic
query setters, query normalization, static setQuery, malformed query charset,
query space encoding/decoding, query injection and RFC 3986 reference resolution.
Each record includes its original file and line; source SHA-256 digests are
recorded. Callbacks and expected public results are preserved verbatim except
for four `ok(u._parts.duplicateQueryParameters...)` assertions, retained in the
`omittedInternalAssertions` metadata. Those inspect URIjs-only internal storage;
all the surrounding duplicate-mode serialization/clone checks still execute.
The local runner implements the synchronous QUnit assertion calls with Node's
assertions and verifies the expected assertion count for every callback.

`resolution.json` contains all 21 absoluteTo and 27 relativeTo table entries
from the same upstream suite, including its two expected exceptions. Upstream
expected strings and exception markers remain intact. `nativeDifference` is
local annotation, never a replacement upstream expectation:

- `absolute-base-required`: 11 relative bases rejected by WHATWG URL.
- `relative-reference-retained`: 11 relativeTo cases retaining the input when a
  reference or base lacks a scheme (including the two upstream exceptions).
- `authority-retained`: 7 relativeTo cases retaining the absolute input when
  hostname, port or credentials differ.

All 48 vectors execute with string and wrapper bases. Conforming entries assert
the original upstream result; annotated entries assert the documented wrapper
behavior explicitly. These are regression checks, not 48 claims of equivalence.
The separate RFC 3986 callback supplies another 24 absolute resolution cases.

The fixtures were verified against the original URIjs 1.19.11 implementation
before adding them to Jest. Normal tests need no URIjs/QUnit dependency or network
access. Broader upstream tests also exercise browser integrations, optional
libraries, `_parts` internals, and unsupported API semantics; the scoped suites
here do not imply that the complete upstream project suite passes.
