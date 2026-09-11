# Task 6 report — shared cycling effort metrics

Status: implemented; focused validation passed; ready for controller review.

## Contract and implementation

- `calculateCyclingEffortMetrics(samples, context)` composes the existing training
  engine with movement, environment, weight, threshold-age, interval, best-power,
  source, and per-stream quality evidence. `CyclingEffortMetrics` is its typed
  result. No provider-specific algorithm or client calculation was added.
- `loadCyclingEffortData` extracts the existing bounded sample/best-power,
  historical-setting, and recorded-interval queries from the training repository.
  Existing training uses this loader and the shared calculator; its public
  response snapshots remain unchanged.
- `loadCyclingEffortMetrics` loads complete bundles for at most 25 authorized
  canonical activities. It uses `analytics.activity_sensor_sample FINAL`,
  the deduplicated distance summary, and the existing nearby-weight loader and
  selector used by cycling power curves.
- `PerformanceComparisonRepository.cyclingEfforts(ids, durations)` resolves
  user-owned cycling activities, enforces bounds, translates their source and
  local-date evidence, and returns the complete bundle. The strict
  `cyclingEffortMetricsSchema` validates this reusable result. As specified by
  the plan's Task 6/8 boundary, the existing `compare()` wire response is unchanged;
  Task 8 opts its identity-aware pipeline into the new bundle.
- Includes elapsed/moving duration; distance and moving/max speed; ascent/descent
  and vertical speed over continuous ascending windows; average/normalized power,
  work, VI, IF/TSS; HR/cadence; synchronized power/HR and speed/HR; drift;
  power/HR zones; best powers; weight and average/normalized/best W/kg; recorded
  or inferred interval metrics and Task 5 precedence; temperature and source/device
  provenance; stream coverage, measured zeros, gaps, suspicious and conflicting
  values; explicit unavailable reasons.
- Provider-reported moving time remains evidence with conflicts intact. Moving
  speed uses valid provider moving time with deduplicated distance, or covered
  positive speed samples. Speed/HR requires at least 90% synchronized coverage.
- Threshold lookup is independent per activity date, including unsorted supplied
  histories. Future/current FTP is never back-applied. Configuration age and
  unverified freshness explicitly disclose potentially stale FTP; an arbitrary
  physiological expiry is not invented.
- Weight retains the existing same-day/interpolation/nearby direct measurement
  policy and full provenance. Estimated body composition cannot supply W/kg.
- Best powers are descriptive observed maxima, with an explicit ordinary-workout
  lower-bound caveat and `maximalTest: false`. Direct/estimated/unknown power
  labels remain distinct.

## Review checkpoints

1. Read the exact brief, README and local guidance; confirmed this is the existing
   isolated worktree. No branch switch and no subagents.
2. Baseline: three existing training/comparison contract suites passed, 11 tests.
3. RED before extraction: shared module missing.
4. GREEN after extraction: new metrics and legacy snapshots passed.
5. Additional RED/GREEN: comparison loader, distance/provider moving speed,
   signed environmental values and best-power W/kg; sparse-sample regression.
6. Final review: focused unit tests, real-database behavior, typecheck, scoped
   Biome, and whitespace verification. No broad test suite was run.

## RED evidence

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts --project unit
FAIL: Cannot find module './cycling-effort-metrics.ts'
Test Files  1 failed
```

The next tests failed on actual missing behavior:

```text
Provider moving duration + distance: expected moving speed 10, received null.
Signed temperature coverage: expected zeroSeconds 0, received 1800.
Comparison repository: repository.cyclingEfforts is not a function.
```

Sparse-stream regression, reproduced in both the shared calculator and the
training engine's colocated test:

```text
expected coveredSeconds 20, received 1200
```

Cause: the existing resampler used the uncapped median native interval for
carry-forward even when the gap exceeded its ten-second continuity tolerance.
Fix: cap the native carry-forward interval at ten seconds. Two observations
600 seconds apart now contribute 20 covered seconds and 4 kJ at 200 W, with
normalized power unavailable. This correction applies to both consumers.

## GREEN and validation output

```text
rtk pnpm exec vitest run +  packages/server/src/repositories/cycling-effort-metrics.test.ts +  packages/server/src/repositories/performance-comparison-repository.test.ts +  packages/server/src/repositories/cycling-training-metrics-repository.test.ts +  packages/server/src/mcp/cycling-training-metrics-tool.test.ts +  packages/server/src/mcp/performance-comparison-tool.test.ts +  packages/training/src/cycling-workout-metrics.test.ts --project unit

Test Files  6 passed (6)
Tests       42 passed (42)
Duration    643ms
```

```text
rtk proxy sh -c 'set -a; . ./.env.local; set +a; TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --project integration packages/server/src/repositories/cycling-training-metrics-repository.integration.test.ts'

Test Files  1 passed (1)
Tests       2 passed (2)
```

The integration fixture executes the actual queries against workspace Postgres
and ClickHouse, with minimal final-schema fixtures, duplicate sensor versions,
signed temperatures/elevation, distance, settings, and measured weight.
It does not replay historical ClickHouse backfills. Existing healthy services
were used directly, consistent with the prior task's focused validation context.

```text
rtk pnpm typecheck
TypeScript: No errors found

rtk pnpm exec biome check [10 changed TypeScript files]
Checked 10 files in 39ms. No fixes applied.

rtk git diff --check
passed with no output
```

The unit runner prints its existing esbuild/oxc configuration warning; no test
failed. No HTTP development server was started.

## Material limits and handoff

- The deduplicated sample model does not expose rejected upstream alternatives.
  The bundle explicitly reports this conflict-evidence limitation; observed
  conflicting values at the same sample second are counted and excluded.
- Altitude gain and vertical speed describe covered ascending windows; they are
  not terrain-adjusted performance or a claim that the whole ride is a climb.
- Historical FTP configuration remains effective until replaced. Its age is
  visible, but physiological freshness is unverified; no new stale-age policy
  was assumed.
- The comparison's Task 8 wire integration, route equivalence, trend inference,
  and consumer UI are intentionally outside this task.
- Two shared-training files changed beyond the brief's file list to expose the
  existing resampler for a real server consumer, preserve signed environmental
  values, and fix the reproduced sparse-gap overcount. An existing integration
  suite gained a real-engine shared-bundle scenario.
- Session instructions require automatic pushing of new commits; the focused
  commit will therefore be pushed even though controller review remains pending.

## Retrospective

Reusing the existing workout, weight and interval paths preserved the legacy
contract. Investigation found a real sparse-sampling coverage bug and established
that freshness cannot be inferred from an effective date alone.

Suggested documentation improvement for approval: add a short server README
section naming `loadCyclingEffortMetrics` as the shared comparison entry point
and documenting configuration-age versus physiological-freshness evidence.
The appropriate next-time skills are TDD, verification-before-completion and
integration-tests-ready. No additional runbook changes were made.

Review used the repository's existing formulas and
[TrainingPeaks' NP guidance](https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power),
with design/test/scope review against
[Google's review dimensions](https://google.github.io/eng-practices/review/reviewer/looking-for.html).
