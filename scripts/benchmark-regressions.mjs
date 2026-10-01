import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

// Always compare both synthetic modes/all workloads AND the same MDN replay.
// Each MDN lifecycle must be compiled against its corresponding engine entry.
const [baseline, candidate, fixture, baselineMdn, candidateMdn] = process.argv.slice(2);
assert.ok(baseline && candidate && fixture && baselineMdn && candidateMdn,
  'Usage: benchmark-regressions.mjs BASELINE_ENGINE CANDIDATE_ENGINE HTML_FIXTURE BASELINE_MDN CANDIDATE_MDN');
const samples = process.env.WSE_BENCH_SAMPLES ?? '11';
async function run(script, args) {
  const child = spawn(process.execPath, ['--expose-gc', new URL(script, import.meta.url).pathname, ...args], {
    env: {...process.env, WSE_BENCH_SAMPLES: samples,
      WSE_BENCH_MODES: 'SingleThreadDownloader,MultiThreadDownloader',
      WSE_BENCH_WORKLOADS: 'buffered,streamed,local,markup'},
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
  return JSON.parse(output);
}
const synthetic = await run('benchmark-crawl.mjs', [baseline, candidate]);
const mdn = await run('benchmark-mdn-crawl.mjs', [fixture, baseline, baselineMdn, candidate, candidateMdn]);
const median = values => {
  assert.ok(values.length);
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const comparisons = [];
function compare(name, baseline, candidate) {
  comparisons.push({name, baselineMs: baseline, candidateMs: candidate,
    changePercent: (candidate / baseline - 1) * 100, regression: candidate > baseline});
}
for (const mode of ['SingleThreadDownloader', 'MultiThreadDownloader']) {
  for (const workload of ['buffered', 'streamed', 'local', 'markup']) {
    const values = [0, 1].map(variant => median(synthetic.results.filter(result =>
      result.mode === mode && result.workload === workload && result.variant === variant)
      .map(result => result.totalMs)));
    compare(mode + '/' + workload, ...values);
  }
}
compare('mdn-local/replay', ...[0, 1].map(variant => median(mdn.results.filter(result =>
  result.name === variant).map(result => result.ms))));
const regressions = comparisons.filter(result => result.regression);
console.log(JSON.stringify({samples: Number(samples), comparisons, regressions, synthetic, mdn}, null, 2));
// This is a strict median gate, not a claim of statistical significance.
if (regressions.length) process.exitCode = 1;
