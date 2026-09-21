# Task 1 Report: Metric-stream routes

## Outcome

Added `src/metric-stream/routes.ts` with the public route contract:

- `MetricStreamRoute` is `"live" | "history"`.
- Full refresh jobs route to `history`; all other or absent refresh windows route to `live`.
- Route topics resolve from `METRIC_STREAM_LIVE_TOPIC` and `METRIC_STREAM_HISTORY_TOPIC`.
- Missing topic configuration fails immediately with an explicit required-key error.

Added the colocated test at `src/metric-stream/routes.test.ts` covering route selection, missing topic configuration, and configured topic selection.

## TDD evidence

1. Before implementation, `pnpm vitest src/metric-stream/routes.test.ts` failed during module loading because `./routes.ts` did not exist.
2. After implementation, the same command passed: 1 test file and 3 tests passed.
3. `git diff --check` passed.

## Concerns and follow-up

No concerns. Legacy routing and `METRIC_STREAM_LEGACY_TOPIC` are intentionally outside this task’s contract; the module only defines live/history routing.

## Retrospective

The brief’s exact public contract made the implementation straightforward, and the red/green focused test provided clear evidence. The only investigation needed was confirming the existing `SyncJobData["targetRefreshWindow"]` type and Vitest conventions. Future tasks should continue consuming these exports rather than duplicating route/topic selection logic. No AGENTS.md or README.md change is proposed.
