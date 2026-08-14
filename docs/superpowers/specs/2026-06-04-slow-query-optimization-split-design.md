# Slow Query Optimization Split Design

## Goal

Reduce the slowest production query paths found in Axiom without bundling unrelated performance work into one risky PR.

## Evidence

Axiom `dofek-logs` slow tRPC logs showed 728 slow queries over 7 days and 307 over the most recent 24-hour window. Current repeated offenders were:

- `mobileDashboard.dashboard`: 30 slow logs in 24 hours, max database duration about 31 seconds.
- `recovery.readinessScore`: 28 slow logs in 24 hours, max about 64 seconds.
- `recovery.strainTarget`: 27 slow logs in 24 hours, max about 71 seconds.
- `stress.scores`: 24 slow logs in 24 hours, max about 50 seconds.
- `healthspan.score`: 21 slow logs in 24 hours, max about 45 seconds.
- `bodyAnalytics.smoothedWeight` and `bodyAnalytics.weightPrediction`: 24 slow logs each in 24 hours, with matching timestamps and durations.
- `sleepNeed.performance`: max about 79 seconds in 24 hours.
- `sync.providerStats`: max about 51 seconds in 24 hours.

The largest 7-day outliers included `providerDetail.records` at about 446 seconds and `activity.stream` at about 155 seconds. `activity.stream` has already had a recent optimization on `origin/main` in commit `ad06f204`, so it should be verified before more changes.

Postgres slow-statement logs also showed two slow `SELECT table_name, row_count FROM (...)` admin count queries at about 82-85 seconds.

## Design Principles

- Split by independently testable backend paths.
- Keep every PR small enough to validate with focused tests and Axiom after deploy.
- Prefer precomputed or cached compact read models for repeated analytics windows.
- Avoid changing query semantics unless a test pins the expected behavior first.
- Do not add resilience knobs, broad timeouts, or fallback behavior as a performance fix.

## PR 1: Dashboard Anomaly Path

### Scope

Target `mobileDashboard.dashboard`, specifically the `anomalies` timing segment inside `packages/server/src/routers/mobile-dashboard.ts`.

### Current Behavior

The route computes dashboard readiness, sleep, sleep need, strain, and anomalies in one request. Axiom dashboard timing logs show `anomalies` frequently taking 13-24 seconds, dominating total dashboard latency.

### Proposed Change

Move anomaly detection off the initial dashboard critical path by serving the dashboard from a compact latest-anomaly result. The first implementation should use an explicit repository method that fetches the latest persisted or cached anomaly result for the user and date. If persistence does not exist yet, add the smallest server-owned storage path needed for latest daily anomaly output and update it from the existing anomaly computation path.

### Validation

Add tests proving `mobileDashboard.dashboard` no longer calls the expensive anomaly computation path during the request. Preserve the output shape by returning the latest available anomaly result or `null`.

## PR 2: Provider Records, Provider Stats, And Admin Counts

### Scope

Target `providerDetail.records`, `sync.providerStats`, and admin row counts.

### Current Behavior

`providerDetail.records` uses raw `SELECT *` plus offset pagination for most data types. `sync.providerStats` live-counts many ClickHouse replicated raw tables. Admin table counts perform live counts across large tables.

### Proposed Change

For provider records, use narrow column selection for list rows and reserve full raw payloads for record detail. For large append-heavy tables such as `metricStream`, replace offset pagination with keyset pagination when browsing from the UI/API. For provider stats and admin counts, replace live full-table counting in request paths with a compact cached or incremental stats source. The stats source should expose the same API shapes so UI code stays mostly unchanged.

### Validation

Add unit or integration tests that verify list queries do not select raw payload columns, metric stream pagination uses a stable cursor boundary, and provider stats/admin count routes read from the compact stats source.

## PR 3: Health, Recovery, Stress, And Sleep Read Models

### Scope

Target `healthspan.score`, `recovery.readinessScore`, `recovery.strainTarget`, `stress.scores`, and `sleepNeed.performance`.

### Current Behavior

These procedures repeatedly fetch sleep nights, resting heart rate rows, rolling daily baselines, activity loads, and health metric windows. Some paths run overlapping ClickHouse and Postgres windows in separate procedures during dashboard bursts.

### Proposed Change

Create compact ClickHouse/dbt incremental read models for repeated health windows:

- Daily readiness inputs: heart rate variability, resting heart rate, respiratory rate, sleep efficiency, and rolling baseline values.
- Daily activity load: per-user daily load with acute and chronic windows.
- Sleep performance inputs: latest sleep, rolling duration baseline, consistency, and low-stress component inputs.
- Healthspan weekly inputs: weekly aerobic minutes, high-intensity minutes, strength frequency, sleep duration, steps, resting heart rate, body composition, and VO2 max.

Routes should read these compact tables instead of rebuilding overlapping windows on demand.

### Validation

Add integration tests for the read-model SQL or repository layer that seed minimal raw inputs and assert the same route-level result shape. Add route tests proving the routes call the compact repositories rather than raw sensor-window helpers.

## PR 4: Body Analytics Fetch Deduplication

### Scope

Target `bodyAnalytics.smoothedWeight`, `bodyAnalytics.weightPrediction`, and `bodyAnalytics.recomposition`.

### Current Behavior

`smoothedWeight` and `weightPrediction` fetch the same body weight rows independently and show matching slow timestamps. `recomposition` uses a related body fetch that requires body fat.

### Proposed Change

Add a small repository-level data loader for body measurement rows keyed by user, timezone, end date, days, access window, and body-fat requirement. Use it inside `BodyAnalyticsRepository` so identical in-flight requests dedupe and sequential calls in the same request can reuse rows. Keep computation methods unchanged.

### Validation

Add unit tests that call two analytics methods with matching inputs and assert the body row fetch happens once. Add a second test proving body-fat-required rows are not reused for weight-only calls when that would change behavior.

## PR 5: Activity Stream Verification

### Scope

Verify whether `activity.stream` still needs work after recent `origin/main` commit `ad06f204`.

### Current Behavior

The previous Axiom 7-day window had `activity.stream` outliers above 120 seconds, but it was not a current 24-hour top offender. Recent main includes an activity stream optimization.

### Proposed Change

Do not change code immediately. After the current deployment has enough traffic, re-run Axiom for `activity.stream`. If it remains slow, plan a focused PR around pre-aggregated stream tiles or bucketed stream samples. If it stays out of the current top offenders, close this item with a note.

### Validation

Use Axiom slow-query logs for a post-deploy window. If a code change is needed, add tests around the downsampling contract before modifying the ClickHouse query.

## Rollout Order

1. Dashboard anomaly path.
2. Provider records, provider stats, and admin counts.
3. Health, recovery, stress, and sleep read models.
4. Body analytics fetch deduplication.
5. Activity stream verification.

This order prioritizes the clearest current Axiom evidence and keeps the riskiest modeling work behind smaller fixes.

## Out Of Scope

- Changing UI layout or client rendering behavior.
- Increasing timeouts, memory limits, or slow-query thresholds.
- Reworking authentication, billing access windows, or provider sync semantics.
- Re-optimizing `activity.stream` before checking post-optimization Axiom data.
