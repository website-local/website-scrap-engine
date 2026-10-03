# Repeat repair measurement — 2026-10-03

**The user accepted the measured performance tradeoff on 2026-10-03, and the
correctness fixes are now applied.** The strict non-regression requirement was
not established by measurement; acceptance does not change that result.

Noise was substantially lower. All ten cases retained enough samples. Three
multithreaded crawl cases passed control stability and showed no statistically clear slowdown;
seven other cases still had unstable identical-baseline controls.

The accepted patch passed all 511 tests in 40 suites, lint, strict source/test
typechecking, the build and real Got retry checks on Node 22.13.0 in an isolated
snapshot containing only the accepted code changes. [Acceptance evidence](evidence/repair-acceptance.json)
records the checks and source fingerprints. Manual CI remains pending.

The fresh campaign completed 12 balanced rounds (36 fresh processes) in 182.5
seconds on Node 22.13.0, from 02:41:56 to 02:44:59 UTC. It used the unchanged
previous protocol and fixtures, with new calibration and separate results.
No previous samples were pooled, thresholds adjusted after
calibration or additional rounds appended.

## Protocol and noise

The baseline is `a7d2dbf` plus the retained worker-result cleanup. An identical
baseline control and the isolated stale Retry-After/directory-index repair form
the other two variants. Each case has one discarded warmup and two timed
observations per fresh process; process medians are paired by round. Fixtures
remain small: 12 binary inputs of 64 KiB, six HTML documents, 24 sequential reads
per acquisition observation and 250,000 calculations per retry observation.

CPU and filesystem probes bracket observations; any failing probe excludes all
three variants for that case and round. Five warmups and nine calibration samples
fixed thresholds at 1.5 times the calibration medians: 17.6016 ms CPU and
4.33815 ms I/O. At least eight rounds must qualify. The deterministic paired
bootstrap uses 10,000 resamples. The control 95% interval must contain zero and
fit within ±5%; non-regression requires a nonpositive upper slowdown bound against
both baseline copies.

**13/120 groups (10.8%) were excluded**, versus 56/120 (46.7%) previously. CPU
probes flagged two groups and I/O probes eleven, with no overlap. All cases
retained 10–12 rounds. All 36 processes completed their functional checks.

## Stable-control results

Positive percentages mean slower. These are medians of paired changes, not
ratios of the overall medians; intervals are 95% paired-bootstrap intervals.

| Case | Rounds / 12 | Repair vs baseline | Repair vs identical control |
| --- | ---: | ---: | ---: |
| Multi binary crawl | 11 | -1.46% [-4.62%, +0.65%] | -3.12% [-5.19%, +0.72%] |
| Multi directory-index crawl | 11 | -0.20% [-2.22%, +3.81%] | +0.07% [-1.99%, +6.23%] |
| Multi explicit-index crawl | 10 | +0.49% [-3.06%, +1.33%] | +0.15% [-2.68%, +2.30%] |

All three intervals span zero against both baseline copies. They do not establish
a slowdown, but their positive upper bounds also prevent a strict non-regression
pass. These small fixtures cannot establish behavior for larger crawls.

## Cases with unstable controls

The candidate values below are **tentative descriptive estimates**. None clears
the control requirement; they must not be treated as accepted regression sizes.

| Case | Rounds / 12 | Control 95% interval | Repair vs baseline |
| --- | ---: | ---: | ---: |
| Single binary crawl | 10 | -4.76% to +9.93% | -6.20% [-15.85%, +1.92%] |
| Single directory-index crawl | 11 | -3.31% to +11.22% | -2.51% [-4.35%, +11.69%] |
| Single explicit-index crawl | 11 | -16.25% to +6.87% | +0.64% [-9.27%, +15.84%] |
| Directory-index acquisition | 10 | -10.07% to +11.94% | +10.77% [+6.76%, +18.45%] |
| Explicit-index acquisition | 11 | -3.42% to +7.18% | +4.70% [-5.90%, +6.10%] |
| Retry: transport error | 10 | -12.65% to +5.61% | +2.45% [-4.03%, +10.32%] |
| Retry: Retry-After | 12 | -5.74% to +8.06% | +18.57% [+9.93%, +25.35%] |

Retry-After shows a paired +18.57% against baseline
(+8.65 ns per calculation) and +17.75% against control. Both repair
intervals are positive, so this is a signal of overhead worth retaining, despite
the failed control stability check. The absolute cost is small and is not a
whole-crawl regression estimate.

Directory-index acquisition suggests
+10.77% (+33.82 microseconds per read) against baseline. Its
interval against the identical control spans zero. The repair obtains the selected
file's metadata instead of reusing the directory stat; this is a plausible source
of extra work, but the run does not establish its size reliably.

## Evidence and status

[Complete evidence](evidence/repair-repeat-measurement.json) preserves all samples,
exclusions, intervals, protocol, harnesses and source/build fingerprints. Full
logs remain under `/mnt/e/tmp/wse-repair-repeat-20261003-0241`. The prior campaign
is preserved independently. Source/build and harness hashes match their pre-run
values. No production code changed during measurement, and GitHub APIs and CI
were not used. The evidence records the unapplied status at measurement time;
the later acceptance is documented above.
