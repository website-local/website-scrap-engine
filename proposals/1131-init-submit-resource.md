# life-cycle: expose submit resource to init

https://github.com/website-local/website-scrap-engine/issues/1131

**Non-breaking** — new optional parameter added to `InitLifeCycleFunc`. Existing init hooks that ignore the new parameter continue to work.

## Motivation

The `init` life cycle hook runs once per downloader (or worker) before any resources are processed. Currently, it receives `(pipeline, downloader?)` and can set up state, but has no way to submit resources to the download queue.

Use cases that require submitting resources during init:

- **Dynamic URL seeding** — Load URLs from a database, API, or file at startup rather than passing them as `initialUrl` strings.
- **Sitemap-driven crawling** — Fetch and parse a sitemap during init, submit all discovered URLs as initial resources.
- **Conditional seeding** — Choose which URLs to seed based on runtime state (e.g., only pages that have changed since last crawl).
- **Resuming a previous session** — Load URLs from a saved session file at startup and seed them as initial resources.

Currently, the only way to add initial resources is via `options.initialUrl` (a string array processed by `addInitialResource`). Anything more dynamic requires subclassing `AbstractDownloader` — which is not part of the public life cycle API.

## Design

### Expanded `InitLifeCycleFunc` signature

Add an optional third parameter: a submit function that collects URLs for processing after init completes.

```typescript
export interface InitSubmitFunc {
  /**
   * Submit a raw URL to be processed through the full pipeline
   * after all init hooks complete.
   *
   * This is fire-and-forget: the URL is appended to the initial URL list
   * and processed identically to entries in `options.initialUrl`.
   * No pipeline stages run during the call.
   */
  (url: string): void;
}

export interface InitLifeCycleFunc {
  /**
   * @param pipeline the PipelineExecutor
   * @param downloader the DownloaderWithMeta when in main thread
   * @param submit function to submit URLs; undefined in worker threads
   */
  (pipeline: PipelineExecutor,
   downloader?: DownloaderWithMeta,
   submit?: InitSubmitFunc): AsyncResult<void>;
}
```

The submit function is **synchronous and fire-and-forget**: it appends the URL to the same array that `addInitialResource` iterates after all init hooks complete. No pipeline stages run during the call. This avoids deadlocks — pipeline stages 1-4 assume init is done, so running them during init would either deadlock (if awaited) or violate the invariant (if not).

### Why not accept `Resource` objects?

An earlier design allowed `submit(res: Resource)` to bypass stages 1-4 with a pre-built Resource. This is dropped because:

1. Building a Resource requires calling `createResource`, which depends on options finalized during init.
2. Pre-built resources skip linkRedirect and detectResourceType, which may produce inconsistent behavior.
3. The simple URL-only API makes the contract clear: all submitted URLs get the same treatment as `initialUrl`.

Consumers who need to submit pre-built resources can do so after init by subclassing `AbstractDownloader` and calling `addProcessedResource` — the same escape hatch available today.

### `submit` is `undefined` in worker threads

Workers run `pipeline.init(pipeline)` without a downloader (line 33 of `worker.ts`). Workers have no download queue — they process individual resources sent from the main thread. Submitting resources from a worker init makes no sense, so `submit` is `undefined` in workers.

Init hooks that use `submit` should guard on its presence:

```typescript
const myInit: InitLifeCycleFunc = async (pipeline, downloader, submit) => {
  if (!submit) return; // worker thread, nothing to do
  const urls = await fetchUrlsFromDatabase();
  for (const url of urls) {
    submit(url);
  }
};
```

### Deferred queuing: why submit must buffer

PQueue auto-starts by default (`autoStart: true`). When `_addProcessedResource` calls `this.queue.add(...)`, the download task can begin executing immediately — including during `await` yields inside init hooks. Pipeline stages 1-4 also assume init is complete. Running them during init — whether awaited or fire-and-forget — would either deadlock or violate this invariant.

The solution is simple: `submit` just pushes URLs into the same array that `addInitialResource` iterates **after** all init hooks complete. No pipeline stages run during init, no queuing, no ordering issues.

### Mutating `urlArr`

`submit` pushes directly into the `urlArr` parameter, which is `options.initialUrl` when called from `_internalInit`. This mutates the caller's options object. This is acceptable because:

- `options.initialUrl` is consumed once during `addInitialResource` and never read again.
- The alternative — copying the array — adds allocation for no benefit since the original array is not reused.
- If a consumer inspects `options.initialUrl` after init for diagnostic purposes, the appended URLs are visible, which is arguably more useful than hiding them.

### Implementation in `AbstractDownloader`

```typescript
async addInitialResource(urlArr: string[]): Promise<void> {
  if (!this._pipeline) {
    await this._initOptions;
  }
  const pipeline = this.pipeline;

  // NEW: submit appends to urlArr; init hooks can add URLs
  // that will be processed in the same loop below
  const submit: InitSubmitFunc = (url: string) => {
    urlArr.push(url);
  };

  await pipeline.init(pipeline, this, submit);

  // Process all URLs: both original initialUrl entries
  // and any added by init hooks via submit
  // noinspection DuplicatedCode
  for (let i = 0; i < urlArr.length; i++) {
    let url: string | void = urlArr[i];
    url = await pipeline.linkRedirect(url, null, null);
    if (!url) continue;
    const type: ResourceType | void = await pipeline.detectResourceType(
      url, ResourceType.Html, null, null);
    if (!type) continue;
    let r: Resource | void = await pipeline.createResource(
      type, 0, url, url,
      undefined, undefined, undefined, type);
    if (!r) continue;
    r = await pipeline.processBeforeDownload(r, null, null);
    if (!r) continue;
    if (!r.shouldBeDiscardedFromDownload) {
      this.addProcessedResource(r);
    }
  }
}
```

Note: the loop condition changes from `i < l` (cached length) to `i < urlArr.length` (live length), so URLs appended by init hooks are naturally picked up. The loop body is unchanged.

### Non-`initialUrl` path

When `initialUrl` is not set, both `SingleThreadDownloader._internalInit` and `MultiThreadDownloader._internalInit` call `pipeline.init(pipeline, this)` directly. These paths must also provide submit and process any URLs it collects:

```typescript
// SingleThreadDownloader._internalInit
protected _internalInit(options: DownloadOptions): Promise<void> {
  if (options.initialUrl) {
    return this.addInitialResource(options.initialUrl);
  } else {
    // init hooks may submit URLs even when initialUrl is not set
    const urls: string[] = [];
    return this.addInitialResource(urls);
  }
}

// MultiThreadDownloader._internalInit (same pattern)
```

This replaces the direct `pipeline.init(pipeline, this)` call with `addInitialResource([])`, which handles both init and the submit-flush loop. When no URLs are submitted, the loop body simply doesn't execute.

### PipelineExecutorImpl changes

Pass the submit function through to the init hooks:

```typescript
async init(
  pipeline: PipelineExecutor,
  downloader?: DownloaderWithMeta,
  submit?: InitSubmitFunc
): Promise<void> {
  if (!this.lifeCycle.init) return;
  for (const init of this.lifeCycle.init) {
    await init(pipeline, downloader, submit);
  }
}
```

### PipelineExecutor interface changes

```typescript
export interface PipelineExecutor {
  init(
    pipeline: PipelineExecutor,
    downloader?: DownloaderWithMeta,
    submit?: InitSubmitFunc
  ): AsyncResult<void>;
  // ... rest unchanged ...
}
```

### Worker thread: no changes

Workers call `pipeline.init(pipeline)` — no downloader, no submit. The third parameter is `undefined`. Existing init hooks that don't use `submit` are unaffected.

### Ordering: init hooks run before `initialUrl`

In `addInitialResource`, `pipeline.init()` is called **before** the URL processing loop. URLs pushed by init hooks via `submit` are appended to the same array, so they are processed **after** the original `initialUrl` entries (appended at the end). All URLs — both original and submitted — go through the pipeline after init completes.

Within the final array:
1. `initialUrl[0]`, `initialUrl[1]`, ... (original entries)
2. URLs from init hook 1 (in submission order)
3. URLs from init hook 2 (in submission order)
4. ...

### Deduplication

Resources submitted via `submit` go through `addProcessedResource` → `_addProcessedResource`, which checks `queuedUrl` for deduplication. If an init hook submits a URL that also appears in `initialUrl`, the `initialUrl` entry wins (it appears earlier in the array and is processed first). The duplicate from `submit` is silently dropped. This is the same behavior as duplicate entries within `initialUrl` today.

## Usage examples

### Load URLs from a database

```typescript
const lifeCycle = defaultLifeCycle();
lifeCycle.init.push(async (pipeline, downloader, submit) => {
  if (!submit) return;
  const urls = await db.query('SELECT url FROM pages WHERE stale = true');
  for (const { url } of urls) {
    submit(url);
  }
});
```

### Fetch and parse a sitemap

```typescript
lifeCycle.init.push(async (pipeline, downloader, submit) => {
  if (!submit) return;
  const resp = await fetch('https://example.com/sitemap.xml');
  const xml = await resp.text();
  const urls = parseSitemapXml(xml); // user's own parser
  for (const url of urls) {
    submit(url);
  }
});
```

## Limitations

- **No submit in workers** — Init hooks that need to submit resources only work in the main thread. This is inherent to the architecture: workers don't own the download queue.
- **No element or parent context** — URLs submitted via `submit` are processed with `element: null` and `parent: null`, same as `initialUrl` entries. They are treated as depth-0 root resources.
- **No custom depth or type** — URLs submitted via `submit` always get `depth: 0` and default to `ResourceType.Html`, same as `initialUrl`. The `detectResourceType` hook can override the type.
- **No pre-built resources** — `submit` only accepts URL strings, not `Resource` objects. See "Why not accept `Resource` objects?" above.
- **No pipeline processing during init** — `submit` is purely a collection mechanism. The URL is not validated, redirected, or processed until after all init hooks complete. This is by design to avoid deadlocks and invariant violations.

## Non-Goals

- It is not a goal to make `submit` available in worker thread init hooks. Workers process individual resources and send results back via IPC — they don't own the queue.
- It is not a goal to replace `initialUrl`. The option remains for simple cases where a static URL list is sufficient.
- It is not a goal to support submitting resources during other life cycle stages (beyond `processAfterDownload` which already has `submit`).
- It is not a goal to add a `remove` or `cancel` counterpart to `submit`.

## Interaction with other proposals

### #731 (custom save path generator)

No direct interaction. URLs submitted via `submit` go through the full pipeline including the `generateSavePath` stage (once implemented).

### #150 (existing local file)

Resources submitted during init are processed identically to `initialUrl` entries. The `existingResource` callback (if present) is checked at download time, after the resource enters the queue.

## Migration

- **Consumers using `defaultLifeCycle()`**: No change needed. The default life cycle has `init: []`, so no init hooks are called.
- **Consumers with existing init hooks**: No change needed. The new `submit` parameter is optional — existing `(pipeline, downloader?)` signatures are compatible since the third argument is simply ignored.
- **Consumers wanting the feature**: Add an init hook that accepts the third `submit` parameter and uses it to seed URLs.
