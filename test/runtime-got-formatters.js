import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import Module, {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';

if (isMainThread) {
  const entry = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href :
    new URL('../lib/index.js', import.meta.url).href;
  const helper = new URL('got-error-formatters.js', entry).href;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'wse-listformat-'));
  const counter = pathToFileURL(path.join(root, 'counter.mjs')).href;
  await fs.writeFile(new URL(counter), `
export const Original = Intl.ListFormat;
export let calls = 0;
export const Counting = new Proxy(Original, {
  construct(target, args, newTarget) {
    calls++;
    return Reflect.construct(target, args, newTarget);
  }
});
Object.defineProperty(Intl, 'ListFormat', {value: Counting});
`);
  const run = scenario => new Promise((resolve, reject) => {
    let result;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {entry, helper, counter, scenario},
      execArgv: scenario === 'preload' ?
        [...process.execArgv, '--import', counter, '--import', helper] : process.execArgv,
    });
    worker.once('message', message => { result = message; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !result) reject(new Error(`Worker ${scenario} exited ${code}`));
      else resolve(result);
    });
  });
  try {
    const baseline = await run('baseline');
    for (const scenario of ['early', 'preload', 'pregot', 'readonly', 'concurrent',
      'race', 'async', 'unsupported', 'failure']) {
      const result = await run(scenario);
      if (scenario !== 'failure') {
        assert.deepEqual(result.outcomes, baseline.outcomes);
        console.log(`${scenario}: ${result.afterImport} eager formatters; restored; assertions matched`);
      } else console.log('load failure propagated; constructor restored');
    }
    console.log('10 isolated import scenarios and 64 assertion outcomes per successful import passed');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
} else {
  const {entry, helper, counter, scenario} = workerData;
  const counts = await import(counter);
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'ListFormat');
  const require = createRequire(entry);
  const gotEntry = require.resolve('got');
  const requireFromGot = createRequire(gotEntry);
  const isEntry = pathToFileURL(requireFromGot.resolve('@sindresorhus/is')).href;

  const loadErrorCodes = {
    race: 'ERR_REQUIRE_ESM_RACE_CONDITION',
    async: 'ERR_REQUIRE_ASYNC_MODULE',
    unsupported: 'ERR_REQUIRE_ESM',
  };
  if (scenario === 'failure' || loadErrorCodes[scenario]) {
    const load = Module._load;
    const sentinel = new Error('deliberate dependency load failure');
    if (loadErrorCodes[scenario]) sentinel.code = loadErrorCodes[scenario];
    Module._load = function (id, ...args) {
      if (id === '@sindresorhus/is') throw sentinel;
      return Reflect.apply(load, this, [id, ...args]);
    };
    try {
      if (scenario === 'failure') await assert.rejects(import(helper), error => error === sentinel);
      else await import(helper);
    } finally {
      Module._load = load;
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(Intl, 'ListFormat'), descriptor);
  }
  if (scenario === 'failure') {
    parentPort.postMessage({afterImport: counts.calls});
  } else {
    if (scenario === 'pregot') await import(pathToFileURL(gotEntry));
    if (scenario === 'readonly') Object.defineProperty(Intl, 'ListFormat', {writable: false});
    if (scenario === 'concurrent') {
      await Promise.all([import(helper), import(pathToFileURL(gotEntry))]);
    } else if (scenario !== 'baseline' && scenario !== 'preload') {
      await import(helper);
    }
    await import(entry);
    assert.equal(Intl.ListFormat, counts.Counting);
    if (scenario !== 'readonly') {
      assert.deepEqual(Object.getOwnPropertyDescriptor(Intl, 'ListFormat'), descriptor);
    }
    const afterImport = counts.calls;
    if (scenario === 'early' || scenario === 'preload') assert.equal(afterImport, 0);
    if (['baseline', 'pregot', 'readonly'].includes(scenario)) assert.equal(afterImport, 2);
    if (loadErrorCodes[scenario]) assert.equal(afterImport, 2);

    const is = await import(isEntry);
    const predicates = [is.isString, is.isNumber, is.isBoolean, is.isNull];
    const inputs = [[], ['ok'], [1], [false], [null], ['ok', 1],
      [{}, Symbol('x'), 1n], [undefined, {}, []]];
    const outcomes = [];
    for (let n = 1; n <= 4; n++) {
      for (const values of inputs) {
        for (const method of ['assertAny', 'assertAll']) {
          try {
            is[method](n === 1 ? predicates[0] : predicates.slice(0, n), ...values);
            outcomes.push({ok: true});
          } catch (error) {
            outcomes.push({type: error.constructor.name, message: error.message});
          }
        }
      }
    }
    assert.equal(counts.calls, 2);
    assert.equal(new Intl.ListFormat('fr').format(['a', 'b']), 'a et b');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Intl.ListFormat, counts.Counting);
    parentPort.postMessage({afterImport, outcomes});
  }
}
