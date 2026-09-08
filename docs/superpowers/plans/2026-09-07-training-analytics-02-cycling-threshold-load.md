# Cycling Threshold, Workout Metrics, and Load Implementation Plan

> Execution follows the approved longitudinal training-analysis design and the
> repository's test-first workflow. Each task ends in a separately pushed
> commit so the existing MCP remains usable throughout.

**Goal:** Add provenance-rich threshold history and estimates, per-activity
cycling analytics, and date-aligned modality-specific training load without
changing or removing the existing summary tools.

**Architecture:** Preserve raw provider threshold observations in Postgres,
keep effective-dated `sport_settings` as configuration, and calculate estimates
from the canonical power-curve repository. Compute workout metrics from
deduplicated ClickHouse activity and sensor data, joining only an FTP setting
that was effective on the activity date. Extend `get_training_load` behind an
optional analytical detail mode while preserving the legacy response shape by
default.

**Stack:** TypeScript, Drizzle/Postgres, ClickHouse read models, Zod, MCP SDK,
Vitest, `@dofek/training` numerical primitives.

## Task 1: Immutable provider threshold observations

**Files:**

- Create: `drizzle/0112_provider_threshold_observation.sql`
- Modify: `src/db/schema/activity.ts`
- Create: `src/db/provider-threshold-observation.ts`
- Create: `src/db/provider-threshold-observation.test.ts`
- Create: `src/db/provider-threshold-observation.integration.test.ts`
- Modify: `src/providers/zwift.ts`
- Modify: `src/providers/zwift.test.ts`

1. Write failing repository and provider tests for idempotent observations,
   source identity, raw evidence, observation/effective timestamps, positive
   values, and Zwift profile `ftp` plus power-curve `zFtp` ingestion.
2. Add one canonical raw-observation table keyed by user, provider, provider
   record ID, threshold type, and observed timestamp. Do not store calculated
   threshold estimates.
3. In Zwift sync, record explicit profile/power-curve values only. A zero or
   absent value produces no observation. One endpoint failing records the
   provider error without discarding successfully synced activities.
4. Run focused unit and executable Postgres integration coverage, then commit
   and push.

## Task 2: Threshold history MCP tool

**Files:**

- Create: `packages/server/src/repositories/cycling-threshold-repository.ts`
- Create: `packages/server/src/repositories/cycling-threshold-repository.test.ts`
- Create: `packages/server/src/mcp/threshold-history-tool.ts`
- Create: `packages/server/src/mcp/threshold-history-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing tests for exact ranges, provider filters, configured versus
   observed evidence, legacy current-profile FTP labeling, pagination, scope,
   and strict output parsing.
2. Query `sport_settings`, provider observations, and legacy `user_profile.ftp`
   as distinct evidence types. Never imply historical validity for the legacy
   current value.
3. Register `get_threshold_history` with `activity:read`; preserve every
   existing tool and output.
4. Run focused tests, commit, and push.

## Task 3: Labeled cycling threshold estimates

**Files:**

- Modify: `packages/training/src/power-analysis.ts`
- Modify: `packages/training/src/power-analysis.test.ts`
- Create: `packages/server/src/repositories/cycling-threshold-estimator.ts`
- Create: `packages/server/src/repositories/cycling-threshold-estimator.test.ts`
- Create: `packages/server/src/mcp/cycling-threshold-estimate-tool.ts`
- Create: `packages/server/src/mcp/cycling-threshold-estimate-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing tests for `recorded_provider`, `twenty_minute_95_percent`,
   `sustained_40_to_70_minutes`, `critical_power_model`, and
   `best_supported`, including insufficient evidence and missing weight.
2. Reuse `CyclingPowerCurveRepository` and the existing critical-power fit.
   Return method, confidence, uncertainty/reason, assumptions, exact evidence
   efforts and activities, and nearby-weight evidence. Calculated results are
   always labeled `estimated`, never measured FTP.
3. Register `estimate_cycling_threshold` with bounded dates and methods.
4. Verify the numerical fixtures independently, commit, and push.

## Task 4: Per-activity cycling workout analytics

**Files:**

- Create: `packages/training/src/cycling-workout-metrics.ts`
- Create: `packages/training/src/cycling-workout-metrics.test.ts`
- Create: `packages/server/src/repositories/cycling-training-metrics-repository.ts`
- Create: `packages/server/src/repositories/cycling-training-metrics-repository.test.ts`
- Create: `packages/server/src/repositories/cycling-training-metrics-repository.integration.test.ts`
- Create: `packages/server/src/mcp/cycling-training-metrics-tool.ts`
- Create: `packages/server/src/mcp/cycling-training-metrics-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`
- Modify: `analytics/README.md`

1. Write pure failing fixtures for time-weighted average/work, normalized
   power, variability index, zones, aerobic efficiency, equal-moving-time
   decoupling, coverage, gaps, measured zeroes, and recorded/detected interval
   statistics.
2. Implement numerical primitives over synchronized one-second samples. Reject
   discontinuous normalized-power windows and retain null plus a reason when
   coverage, HR, zones, or historical FTP are missing.
3. Build the exact-range repository over canonical cycling activities,
   deduplicated streams, recorded intervals, effective-dated settings, and the
   existing power-curve repository. Preserve provider/device/member evidence.
4. Register `get_cycling_training_metrics` with selected best-power durations,
   filters, cursor pagination, and `activity:read`.
5. Prove complete 1 Hz, irregular, dropout, HR-only, power-only, Peloton,
   Wahoo, duplicate, changed-FTP, and missing-FTP behavior in a real
   ClickHouse/Postgres integration fixture. Commit and push.

## Task 5: Analytical modality-specific daily load

**Files:**

- Create: `packages/server/src/repositories/analytical-training-load-repository.ts`
- Create: `packages/server/src/repositories/analytical-training-load-repository.test.ts`
- Create: `packages/server/src/repositories/analytical-training-load-repository.integration.test.ts`
- Modify: `packages/server/src/mcp/training-load-tool.ts`
- Modify: `packages/server/src/mcp/training-load-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing tests for a complete date spine and separate cardiovascular,
   climbing, finger, and strength dimensions. Assert `scalar_value` is always
   null with the non-interchangeability reason.
2. Calculate power TSS only from valid workout NP plus effective historical
   FTP; calculate Edwards HR load only with historical HR zones; calculate
   session-RPE as minutes times recorded RPE. Preserve native climbing,
   finger, and strength units.
3. For each unchanged dimension, calculate seven-day acute sum, 28-day weekly
   equivalent, ratio only at full coverage, monotony, and strain. Zero variance
   yields unavailable monotony, not infinity.
4. Add `detail: "analytical"` to `get_training_load`; keep the omitted/default
   legacy response byte-for-byte compatible.
5. Prove duplicate activities do not double load, run focused integration and
   transport tests, document formulas and non-causal interpretation, commit,
   and push.

## Review Checkpoint

After Task 5, run lint, typecheck, Knip, changed unit tests, and focused real
database integration suites. If the deployed connector and historical refresh
are available, answer cycling acceptance questions 1–7 from the authorized
dataset. Otherwise record the exact deployment/backfill prerequisite and do
not guess. Then write the climbing/finger/strength progression plan.
