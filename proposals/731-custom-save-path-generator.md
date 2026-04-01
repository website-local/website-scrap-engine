# Custom dir prefix generator for generateSavePath

https://github.com/website-local/website-scrap-engine/issues/731

**BREAKING CHANGE** — `generateSavePath` on `ProcessingLifeCycle` changes from a single optional function to an array-based life cycle stage. `CreateResourceArgument` gains required fields and loses `generateSavePathFn`.

**Interacts with**: [#993](https://github.com/website-local/website-scrap-engine/issues/993) (binary misdetected as html — Phase 2 re-generates save paths, should use this life cycle stage instead of calling `generateSavePath` directly), [#150](https://github.com/website-local/website-scrap-engine/issues/150) (existing local file — uses `res.savePath` to check local files; the `generateSavePath` stage runs before download, so save paths are finalized before the `existingResource` check).

## Motivation

Users need to map different hosts and paths to different save directories. For example:

- Save `cdn.example.com` assets under `assets/` instead of `cdn.example.com/`
- Route `example.com/blog/` to `blog/` and `example.com/docs/` to `docs/`
- Deduplicate resources from multiple CDN hosts into a single directory

The current `generateSavePathFn` on `CreateResourceArgument` is a single function override — it replaces the entire save-path logic. There is no composable way to prepend/append path transformations, and the function receives only `(uri, isHtml, keepSearch, localSrcRoot)` with no access to the resource type, parent, or options.

Additionally, `createResource` is a single function on `ProcessingLifeCycle` (not an array), making it impossible to compose multiple transformations without wrapping/replacing the whole function.

## Design

### New life cycle stage: `generateSavePath`

Split save-path generation out of `createResource` into its own pipeline stage as an **array of functions**, inserted between `detectResourceType` and `createResource`.

```typescript
export interface GenerateSavePathContext {
  /** The resolved absolute URI */
  uri: URI;
  /** Resource type (determines isHtml logic) */
  type: ResourceType;
  /** Depth from root */
  depth: number;
  /** The raw url string before resolution */
  rawUrl: string;
  /** Parent resource URL */
  refUrl: string;
  /** Parent save path (if known) */
  refSavePath?: string;
  /** Parent resource type */
  refType?: ResourceType;
  /** Options */
  options: StaticDownloadOptions;
}

export interface GenerateSavePathResult {
  /** The save path relative to localRoot */
  savePath: string;
  /** Optional: override the refSavePath used for replacePath calculation */
  refSavePath?: string;
}

export interface GenerateSavePathFunc {
  /**
   * Generate or transform the save path for a resource.
   *
   * The first function in the array receives a default savePath computed
   * by the built-in generateSavePath logic. Each subsequent function
   * receives the savePath returned by the previous function.
   *
   * Return void to discard the resource.
   */
  (savePath: string, ctx: GenerateSavePathContext):
    AsyncResult<string | GenerateSavePathResult | void>;
}
```

### Updated `ProcessingLifeCycle`

```typescript
export interface ProcessingLifeCycle {
  init: InitLifeCycleFunc[];
  linkRedirect: LinkRedirectFunc[];
  detectResourceType: DetectResourceTypeFunc[];
  generateSavePath: GenerateSavePathFunc[];  // CHANGED: was `GenerateSavePathFn | void`
  createResource: typeof createResource;     // simplified, no longer owns save-path logic
  processBeforeDownload: ProcessResourceBeforeDownloadFunc[];
  download: DownloadResourceFunc[];
  processAfterDownload: ProcessResourceAfterDownloadFunc[];
  saveToDisk: SaveToDiskFunc[];
  dispose: DisposeLifeCycle[];
  statusChange: StatusChangeFunc[];
  existingResource?: ExistingResourceFunc;
}
```

### Pipeline stages (updated order)

1. **linkRedirect** — skip or redirect URLs
2. **detectResourceType** — determine resource type
3. **generateSavePath** — compute save path (NEW)
4. **createResource** — build Resource object using the save path from step 3
5. **processBeforeDownload** — filter/modify; link replacement happens after
6. **download** — fetch resource
7. **processAfterDownload** — parse content, discover children
8. **saveToDisk** — write to filesystem

### URL resolution: stays in `createResource`

The URL resolution logic in `createResource` (lines 517-548 of `resource.ts`) — handling protocol-relative URLs, absolute paths, relative URLs, file:// URLs — **stays in `createResource`**. It is not moved to the `generateSavePath` stage.

This means the `generateSavePath` stage receives a **pre-resolved URI**. The pipeline executor resolves the URI before calling the `generateSavePath` hooks, then passes both the resolved URI and the computed save path to `createResource`.

Concretely, `PipelineExecutorImpl` extracts the URL resolution into a private helper `_resolveUri`:

```typescript
/**
 * Resolve a raw URL against a refUrl into an absolute URI.
 * Extracted from createResource() for use before generateSavePath.
 */
private _resolveUri(
  rawUrl: string, refUrl: string
): { uri: URI; url: string; replacePathHasError: boolean } {
  let url = rawUrl;
  const refUri = URI(refUrl);
  let replacePathHasError = false;

  if (url.startsWith('file:///') || refUrl.startsWith('file:///')) {
    url = resolveFileUrl(url, refUrl,
      this.options.localSrcRoot, this.options.skipReplacePathError);
    if (!url) {
      replacePathHasError = true;
      url = rawUrl;
    }
  }
  if (!replacePathHasError && url.startsWith('//')) {
    url = refUri.protocol() + ':' + url;
  } else if (!replacePathHasError && url[0] === '/') {
    url = refUri.protocol() + '://' + refUri.host() + url;
  }
  let uri = URI(url);
  if (!replacePathHasError && uri.is('relative')) {
    uri = uri.absoluteTo(refUri);
    url = uri.toString();
  }
  if (!replacePathHasError &&
    checkAbsoluteUri(uri, refUri, this.options.skipReplacePathError,
      url, refUrl, 0 /* type not yet needed */)) {
    replacePathHasError = true;
  }

  return { uri, url, replacePathHasError };
}
```

This is a **refactor, not a behavior change** — the same resolution logic runs, just earlier in the pipeline so the URI is available for save-path generation.

### Initial resources (depth 0)

Initial resources have no parent. Currently `createResource` computes `refSavePath` via `generateSavePath(refUri, refType === ResourceType.Html, ...)` when `refSavePath` is not provided. In the new design:

- For child resources, `refSavePath` is the parent's `savePath` (already known).
- For initial resources added via `addInitialResource` in the downloader, `refSavePath` is computed by the built-in `generateSavePath` function as today — the `generateSavePath` life cycle hooks are **not** run for the refSavePath calculation. This keeps the hooks focused on the current resource's path.

### Execution semantics

The `generateSavePath` array follows the same short-circuit-on-void pattern as other stages:

```typescript
async generateSavePath(
  uri: URI, type: ResourceType, depth: number,
  rawUrl: string, refUrl: string,
  refSavePath?: string, refType?: ResourceType
): Promise<{ savePath: string; refSavePath?: string } | void> {
  const isHtml = type === ResourceType.Html;
  const keepSearch = !this.options.deduplicateStripSearch;
  const localSrcRoot = this.options.localSrcRoot;

  // Compute the default save path using built-in logic
  let savePath = builtinGenerateSavePath(uri, isHtml, keepSearch, localSrcRoot);
  let resultRefSavePath = refSavePath;

  if (!this.lifeCycle.generateSavePath.length) {
    return { savePath, refSavePath: resultRefSavePath };
  }

  const ctx: GenerateSavePathContext = {
    uri, type, depth, rawUrl, refUrl,
    refSavePath, refType, options: this.options
  };

  for (const fn of this.lifeCycle.generateSavePath) {
    const result = await fn(savePath, ctx);
    if (result === undefined) return undefined;
    if (typeof result === 'string') {
      savePath = result;
    } else {
      savePath = result.savePath;
      if (result.refSavePath !== undefined) {
        resultRefSavePath = result.refSavePath;
      }
    }
  }

  return { savePath, refSavePath: resultRefSavePath };
}
```

### Changes to `CreateResourceArgument`

The `createResource` function receives the pre-computed `savePath`:

```typescript
export interface CreateResourceArgument {
  type: ResourceType;
  depth: number;
  url: string;
  refUrl: string;
  localRoot: string;
  encoding?: ResourceEncoding;
  keepSearch?: boolean;
  skipReplacePathError?: boolean;
  localSrcRoot?: string;
  // NEW: pre-computed by the generateSavePath life cycle
  savePath: string;
  refSavePath: string;
}
```

Removed fields:
- `generateSavePathFn` — replaced by the life cycle array
- `refType` — only needed for save-path generation, now handled in the life cycle

### Changes to `PipelineExecutorImpl.createAndProcessResource`

```typescript
async createAndProcessResource(
  rawUrl: string,
  defaultType: ResourceType,
  depth: number | void | null,
  element: Cheerio | null,
  parent: Resource
): Promise<Resource | void> {
  const url: string | void = await this.linkRedirect(rawUrl, element, parent);
  if (!url) return;
  const type = await this.detectResourceType(url, defaultType, element, parent);
  if (!type) return;
  const refUrl = parent.redirectedUrl || parent.url;
  const refSavePath = refUrl === parent.url ? parent.savePath : undefined;

  // NEW: resolve URI early for generateSavePath
  const resolved = this._resolveUri(url, refUrl);

  const savePathResult = await this.generateSavePath(
    resolved.uri, type, depth || parent.depth + 1,
    url, refUrl, refSavePath, parent.type);
  if (!savePathResult) return;

  const r = this.createResource(type, depth || parent.depth + 1, url,
    refUrl, parent.localRoot,
    this.options.encoding[type],
    savePathResult.savePath,
    savePathResult.refSavePath);
  if (!r) return;
  return await this.processBeforeDownload(r, element, parent, this.options);
}
```

### Default life cycle

```typescript
export const defaultLifeCycle = (): ProcessingLifeCycle => ({
  init: [],
  linkRedirect: [skipLinks],
  detectResourceType: [detectResourceType],
  generateSavePath: [],  // empty = use built-in default, no transformations
  createResource,
  processBeforeDownload: [],
  download: [downloadResource, downloadStreamingResource, readOrCopyLocalResource],
  processAfterDownload: [
    processRedirectedUrl, processHtml, processHtmlMetaRefresh,
    processSvg, processCss, processSiteMap
  ],
  saveToDisk: [saveHtmlToDisk, saveResourceToDisk],
  dispose: [],
  statusChange: [defaultStatusListener]
});
```

When the array is empty, `PipelineExecutorImpl.generateSavePath()` computes the default save path via the built-in function and returns it without further transformation.

## Usage examples

### Map CDN host to local directory

```typescript
const lifeCycle = defaultLifeCycle();
lifeCycle.generateSavePath.push((savePath, ctx) => {
  if (ctx.uri.hostname() === 'cdn.example.com') {
    // Strip the host prefix and put under assets/
    const pathPart = savePath.slice('cdn.example.com/'.length);
    return 'assets/' + pathPart;
  }
  return savePath;
});
```

### Flatten multiple CDN hosts

```typescript
lifeCycle.generateSavePath.push((savePath, ctx) => {
  const cdnHosts = ['cdn1.example.com', 'cdn2.example.com', 'static.example.com'];
  const host = ctx.uri.hostname();
  if (cdnHosts.includes(host)) {
    return savePath.replace(host, 'static');
  }
  return savePath;
});
```

### Route by path prefix

```typescript
lifeCycle.generateSavePath.push((savePath, ctx) => {
  const p = ctx.uri.path();
  if (p.startsWith('/blog/')) {
    return 'blog' + savePath.slice(savePath.indexOf('/blog/') + '/blog'.length);
  }
  return savePath;
});
```

## Limitations

- **`replacePath` depends on both `savePath` and `refSavePath`** — If a hook changes `savePath` for some resources but not others, the relative `replacePath` between parent and child will still be correct (it is computed from the two save paths). But if a hook changes the directory structure in a way that makes the relative path very long (e.g., moving a resource from `a/b/c/` to `x/`), the replacement link will be a long `../../../x/...` path. This is correct but may surprise users.
- **`redirectedSavePath` is unaffected** — Post-download redirect handling (`processRedirectedUrl` in `adapters.ts`) recomputes `redirectedSavePath` using the built-in `generateSavePath`. The life cycle hooks are **not** re-run for redirected paths. A future enhancement could add a second `generateSavePath` invocation for redirects.
- **No access to the element or parent Resource** — Unlike `linkRedirect` and `detectResourceType`, the `generateSavePath` hook does not receive the source element or parent `Resource` object. It receives `refUrl`, `refSavePath`, and `refType` instead. This is intentional: save-path generation should depend on the URL, not on the DOM context. Consumers who need element-based logic should use `processBeforeDownload` to modify `savePath` after resource creation.

## Non-Goals

- It is not a goal to make `createResource` itself an array-based hook. The function assembles a `Resource` from computed values — there is no meaningful composition of multiple "create resource" functions.
- It is not a goal to support async `createResource`. The function is pure computation (no I/O).
- It is not a goal to change how `replacePath` is computed. It remains derived from `savePath` and `refSavePath` inside `createResource`.
- It is not a goal to add element/parent access to the `generateSavePath` context. See Limitations.

## Interaction with other proposals

### #993 (binary misdetected as html)

Phase 2 of #993 proposes re-generating the save path when a content-type mismatch is detected after download. With this proposal, the re-generation should invoke the `generateSavePath` life cycle hooks (not just the built-in function) so that custom path mappings are applied consistently. This means `PipelineExecutorImpl` needs a way to re-run `generateSavePath` for an already-created resource — likely by exposing the `generateSavePath` method and updating `savePath`/`replacePath` on the existing `Resource`.

### #150 (existing local file)

The `existingResource` callback uses `res.savePath` to locate the local file. Since `generateSavePath` runs before `createResource`, which runs before `download`, the save path is finalized before the `existingResource` check at the download stage. No ordering issue.

### #204 (configurable logger)

No interaction. The `generateSavePath` stage does not produce log output (the built-in function logs only for `keepSearch` hash replacement via `log.debug`, which is internal to the function).

## Migration

### Breaking changes

1. `ProcessingLifeCycle.generateSavePath` changes from `GenerateSavePathFn | void` (single optional function) to `GenerateSavePathFunc[]` (array with new signature).
2. `CreateResourceArgument.generateSavePathFn` is removed.
3. `CreateResourceArgument` gains required `savePath` and `refSavePath` fields; loses `refType`.
4. The exported `GenerateSavePathFn` type is removed.

### Migration wrapper

A compatibility wrapper converts old-style `GenerateSavePathFn` to the new `GenerateSavePathFunc`:

```typescript
import type {GenerateSavePathFunc} from './life-cycle/types.js';

/**
 * Wrap a legacy GenerateSavePathFn (old signature) into
 * the new GenerateSavePathFunc life cycle hook.
 *
 * @deprecated Use the new GenerateSavePathFunc signature directly.
 */
export function wrapLegacyGenerateSavePath(
  legacyFn: (uri: URI, isHtml?: boolean, keepSearch?: boolean,
    localSrcRoot?: string) => string
): GenerateSavePathFunc {
  return (_savePath, ctx) => {
    const isHtml = ctx.type === ResourceType.Html;
    const keepSearch = !ctx.options.deduplicateStripSearch;
    return legacyFn(ctx.uri, isHtml, keepSearch, ctx.options.localSrcRoot);
  };
}
```

Users migrate by replacing:

```typescript
// Before
const lifeCycle = defaultLifeCycle();
lifeCycle.generateSavePath = myCustomGenerateSavePath;

// After
const lifeCycle = defaultLifeCycle();
lifeCycle.generateSavePath.push(
  wrapLegacyGenerateSavePath(myCustomGenerateSavePath)
);
```

### Consumers using `defaultLifeCycle()`

No change needed if not using `generateSavePath`. The array is empty by default, behavior is identical.

### Consumers building `ProcessingLifeCycle` from scratch

Add `generateSavePath: []` to the life cycle object. The pipeline executor uses the built-in default when the array is empty.
