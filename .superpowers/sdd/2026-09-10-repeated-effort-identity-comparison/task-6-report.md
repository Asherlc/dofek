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

## Fix round 1 — 2026-09-10

All four review findings addressed in the current worktree, without subagents
or a branch switch.

1. The cleaner and shared resampler retain native fractional elapsed timestamps.
   Conflict detection now compares simultaneous values only. Resampling integrates
   the duration of each sequential observation into one-second buckets, preserving
   native observation count and cadence. A 60-second 2Hz stream alternating 100/300 W
   produces 120 observations, 200 W average/NP, and 12 kJ.
2. Every stream retains conflict timestamps as resampling barriers. Earlier samples
   stop at the barrier; coverage resumes only with another valid observation.
   A second containing any missing/conflicting fraction remains missing. Work,
   distance, paired coverage, zones, and NP consume those same masked buckets.
   Elevation windows cannot bridge conflicts either. Measured zeros remain zeros;
   exact duplicate observations do not become conflicts. Unaffected streams retain
   their independent coverage.
3. Stored inferred intervals are normalized in both the nested workout and the
   top-level interval result, including `workout.intervalSource`, with null targets
   and completion. Provenance matching uses the same clipped boundaries as interval
   calculation, so clipping a 60-second interval to a 30-second effort retains its
   inferred source and original raw evidence.
4. Each stream's strict result schema now includes `measurementKinds` and `evidence`
   tuples represented as `{providerId, deviceId, measurementKind}`. The core SQL
   query retains channel/provider/device/kind associations; movement/environment
   evidence is carried from its existing query. Direct, estimated, and unknown
   remain distinct, including nullable devices. Repeated identical evidence is
   consolidated without losing the provider/device association.

Added local unavailable reasons for average power, work, VI, average moving speed,
maximum speed, elevation gain/loss, average/normalized W/kg, and absent valid power
zone boundaries. Historical FTP selection/freshness and the ordinary-workout
best-power lower-bound caveat remain covered by the existing tests.

### Regression checkpoints and exact commands

The first RED run preceded production edits:

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts packages/training/src/cycling-workout-metrics.test.ts --project unit

Test Files  2 failed (2)
Tests       6 failed | 18 passed (24)
```

Failures: 2Hz samples reported 60 conflicts/zero coverage in the bundle and only
60 native observations in the engine; integer and fractional conflicts incorrectly
reported 60 covered/zero missing seconds; stored inferred intervals reported
`recorded`; `average_power` had no unavailable reason.

The database RED run used the actual workspace Postgres and ClickHouse:

```text
rtk proxy sh -c 'set -a; . ./.env.local; set +a; TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --project integration packages/server/src/repositories/cycling-training-metrics-repository.integration.test.ts'

Test Files  1 failed (1)
Tests       1 failed | 1 passed (2)
```

Failure: the shared bundle lacked per-stream `measurementKinds` and `evidence`.
The fixture now verifies all six streams, including estimated speed, unknown
altitude, signed temperature, distinct heart-rate provenance, null cadence device,
and deduplication of superseded import versions. It validates the produced bundle
against `cyclingEffortMetricsSchema`.

Additional RED during final review:

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts --project unit

normalizes stored inferred intervals in every representation for a 30-second effort
AssertionError: expected 'recorded' to be 'inferred'
Test Files  1 failed (1)
Tests       1 failed | 14 passed (15)
```

Final focused unit validation:

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts packages/server/src/repositories/performance-comparison-repository.test.ts packages/server/src/repositories/cycling-training-metrics-repository.test.ts packages/server/src/mcp/cycling-training-metrics-tool.test.ts packages/server/src/mcp/performance-comparison-tool.test.ts packages/training/src/cycling-workout-metrics.test.ts --project unit

Test Files  6 passed (6)
Tests       50 passed (50)
Duration    973ms
```

Final database validation (same command as the database RED run):

```text
Test Files  1 passed (1)
Tests       2 passed (2)
Duration    16.99s
```

Three existing SQL snapshots initially failed because the query added the
`stream_evidence` column. Refreshed with:

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-training-metrics-repository.test.ts --project unit --update

Snapshots   3 updated
Test Files  1 passed (1)
Tests       4 passed (4)
```

Diff review confirms only the SQL snapshots changed; legacy response snapshots
did not change. Formatting initially flagged a prohibited type assertion and
assignments inside expressions; both were rewritten without suppressions.

```text
rtk pnpm exec biome check packages/server/src/repositories/cycling-effort-metrics.ts packages/server/src/repositories/cycling-effort-metrics.test.ts packages/server/src/repositories/cycling-training-metrics-repository.integration.test.ts packages/server/src/repositories/cycling-training-metrics-repository.test.ts packages/server/src/repositories/performance-comparison-repository.test.ts packages/server/src/mcp/performance-comparison-output.ts packages/training/src/cycling-workout-metrics.ts packages/training/src/cycling-workout-metrics.test.ts

Checked 8 files in 104ms. No fixes applied.

rtk pnpm typecheck
TypeScript: No errors found

rtk git diff --check
No output; exit 0.
```

The unit runner still prints its existing esbuild/oxc warning. No HTTP development
server was started, and no dependencies, environment variables, schema migrations,
client behavior, or production infrastructure changed. Validation reused healthy
workspace Postgres/ClickHouse services; unrelated Redpanda was observed restarting
but is not used by this suite and was not changed.

### Fix-round retrospective

The focused regressions caught timestamp quantization, conflict interpolation, and
interval clipping independently; real database validation confirmed tuple/null
semantics and all six provenance channels. Next-time context: preserve native
timestamps until resampling, preserve invalid spans explicitly, and match evidence
after the same boundary normalization as calculation. Suggested documentation
change for approval: add those three review checks to the training README's metric
contract. TDD, verification-before-completion, and integration-tests-ready remain
the useful skills for similar fixes. The upstream model still does not expose
rejected alternatives; this fix preserves that existing limitation explicitly.

## Fix round 2 — 2026-09-10

Status: fixed; focused validation passed; ready for controller re-review.

Root cause: round 1's duration-weighted one-second bucket values became the
inputs to maximum speed and maximum heart rate, suppressing native subsecond
peaks. The shared resampler now retains native peaks separately and returns
`maximumValue` from buckets satisfying the existing full-coverage mask. Both
maximum consumers use it. Weighted averages, integrated distance/work, zones,
paired coverage, and conflict barriers retain their existing calculation paths.
Partly covered/conflicted buckets still cannot contribute peaks. No new
physiological ceiling, provenance rule, or maximal-effort interpretation was added.

### Regression evidence and exact commands

Extended both existing subsecond tests and added the focused mixed-quality test
`excludes conflicting, suspicious, and partially covered peaks while retaining native valid peaks`.
Expected values were calculated by hand. The first run preceded production edits:

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts packages/training/src/cycling-workout-metrics.test.ts --project unit

AssertionError: expected { averageBpm: 150, maximumBpm: 150 } to deeply equal { averageBpm: 150, maximumBpm: 180 }
maximumSpeedMetersPerSecond: expected 20, received 15 (both server regressions)
Test Files  2 failed (2)
Tests       3 failed | 24 passed (27)
Duration    498ms
```

Same command after implementation:

```text
Test Files  2 passed (2)
Tests       27 passed (27)
Duration    568ms
```

The 60-second 2Hz fixture now reports maximum speed 20 m/s and maximum HR
180 bpm while retaining average speed 15 m/s, average HR 150 bpm, distance
900 m, 60 paired seconds, speed/HR 0.1, 200 W average/NP, and 12 kJ work.
The mixed-quality fixture retains a valid subsecond peak while excluding larger
conflicting, out-of-range, nonfinite, and partly covered peaks; it verifies
independent quality counts, measured zeros, missing seconds, duplicate handling,
the paired-coverage gate, and strict output-schema validation.

Final contract validation:

```text
rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts packages/server/src/repositories/performance-comparison-repository.test.ts packages/server/src/repositories/cycling-training-metrics-repository.test.ts packages/server/src/mcp/cycling-training-metrics-tool.test.ts packages/server/src/mcp/performance-comparison-tool.test.ts packages/training/src/cycling-workout-metrics.test.ts --project unit

Test Files  6 passed (6)
Tests       51 passed (51)
Duration    1.81s

rtk pnpm typecheck
TypeScript: No errors found

rtk pnpm exec biome check packages/server/src/repositories/cycling-effort-metrics.ts packages/server/src/repositories/cycling-effort-metrics.test.ts packages/training/src/cycling-workout-metrics.ts packages/training/src/cycling-workout-metrics.test.ts
Checked 4 files in 57ms. No fixes applied.

rtk git diff --check
No output; exit 0.
```

Biome initially requested multiline formatting for one test fixture; corrected
before the final checks. Vitest retains the existing esbuild/oxc warning. No
snapshots changed. Database tests were not rerun: this correction only changes
in-memory calculation, with no query, schema, or loader changes. Existing
provenance and ordinary-best-power lower-bound/`maximalTest: false` assertions
pass in the focused suites. No subagents, branch switches, or HTTP servers.

### Fix-round retrospective

TDD reproduced both consumer failures before the fix; the mixed-quality fixture
checked that restoring peaks did not bypass coverage masking. Investigation
confirmed that peaks and weighted averages need separate resampling outputs.
Suggested training README addition for approval: document native maxima versus
duration-weighted averages, including the shared full-bucket validity requirement.
Use systematic-debugging, test-driven-development, and
verification-before-completion for the next similar regression.
