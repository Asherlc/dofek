# Sleep Data Quality Flags TDD Plan

> **For agentic workers:** Follow the repository's test-driven development rules. This plan implements existing issue [#2249](https://github.com/Asherlc/dofek/issues/2249); do not create a duplicate issue.

**Goal:** Preserve incomplete sleep records without allowing unreported stage or efficiency values to corrupt downstream summaries.

**Behavior:** Sleep writers store `NULL` for unreported values and set `staging_available` only when the complete canonical stage bundle is available. Analytics, APIs, MCP, web, and mobile preserve and expose that signal; averages exclude unavailable values and clients identify partial nights.

**Scope:** Audit and correct every current sleep writer; add Postgres and ClickHouse schema support; provide a bounded preview/execute backfill for existing rows; update sleep read models, recovery aggregation, tRPC/MCP output, and web/mobile presentation. Other record types and generalized confidence scoring are non-goals.

**Docs:** [Issue #2249](https://github.com/Asherlc/dofek/issues/2249), [`docs/schema.md`](../../schema.md), [`analytics/README.md`](../../../analytics/README.md)

---

## Current Evidence

- Apple Health import and HealthKit sync initialize all stage totals to zero even when an in-bed interval has no granular sleep stages.
- Garmin and legacy WHOOP parsing use `?? 0` for missing stage summaries, making absence indistinguishable from measured zero.
- Other writers already preserve optional stage fields, but no canonical signal tells consumers whether the full deep/REM/light/awake bundle is available.
- `recovery.sleepAnalytics` converts missing efficiency and stage values to zero and averages the resulting sentinel values.
- `analytics.v_sleep`, `analytics.daily_sleep`, `sleep.list`, and `get_sleep_summary` do not expose completeness.
- Apple Health ingestion has no measured efficiency input, so an existing Apple Health `efficiency_pct = 0` is an unambiguous sentinel. Existing all-zero Apple stage totals without retained `sleep_stage` rows are likewise distinguishable from retained measured stages.

## Test Strategy

- Unit: provider parsers and writers preserve missing stage values and set `staging_available` from source presence; recovery aggregation excludes incomplete stage/efficiency values; MCP returns the flag; web/mobile render a partial-data indication.
- Integration: a real PostgreSQL test verifies Apple Health/HealthKit persistence uses `NULL` plus the flag; a real ClickHouse test verifies the flag survives CDC/read-model projection; the recovery endpoint test reproduces a mixed complete/incomplete-provider average without sentinel-zero corruption.
- UI/mobile/web parity: web chart/source rows and the mobile sleep screen both identify partial nights, with colocated component/screen tests and updated stories where an existing component is modified.

## File Structure

- Modify: `src/db/schema/activity.ts`, `drizzle/0066_sleep_staging_available.sql`, `drizzle/meta/_journal.json` — canonical Postgres column.
- Modify/create: `scripts/backfill-sleep-quality.ts` and focused tests/docs — bounded existing-row normalization.
- Modify: current sleep provider parsers/persisters under `src/providers/` plus HealthKit/Zepp ingestion paths — writer correctness.
- Modify/create: `src/db/clickhouse-raw-tables.ts`, `src/db/clickhouse-read-models.ts`, a new ClickHouse migration, and `analytics/models/read_models/daily_sleep.sql` — projection and serving flag.
- Modify: sleep repositories, recovery router, and MCP tool — API propagation and correct averages.
- Modify: web sleep components/page and mobile sleep screen — partial-record indication.

## Tasks

### Task 1: Add Failing Persistence and Parser Tests

- [x] Add provider/parser tests for missing stage summaries and Apple/HealthKit rows without granular stages.
- [x] Run `rtk pnpm vitest run <focused provider and HealthKit test files>`.
- [x] Confirm failures show current zero sentinels or the missing flag.

### Task 2: Add Failing Database and Aggregation Tests

- [x] Extend the executable PostgreSQL and ClickHouse sleep integration fixtures with `staging_available`.
- [x] Add the mixed-provider recovery average regression.
- [ ] Run `rtk pnpm test:integration -- <focused integration files>` and `rtk pnpm vitest run packages/server/src/routers/recovery.test.ts`.
- [ ] Confirm failures are caused by absent quality propagation and zero-inclusive averaging.

### Task 3: Add Failing MCP and Client Tests

- [x] Assert `get_sleep_summary` includes the stage-availability signal.
- [x] Assert web and mobile identify an incomplete night.
- [x] Run `rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/web/src/components/SleepChart.test.tsx` and `rtk pnpm test:mobile -- --run packages/mobile/app/sleep.test.tsx`.
- [x] Confirm failures are caused by missing API/UI behavior.

### Task 4: Implement the Minimal Canonical Fix

- [x] Add the Postgres and ClickHouse schema columns and propagate them through `analytics.v_sleep` and `analytics.daily_sleep`.
- [x] Correct writers so source absence becomes `NULL`, set the flag from source presence, and update conflict paths.
- [x] Make recovery calculations nullable and exclude missing efficiency values from the average.
- [x] Surface the flag through tRPC/MCP and render the partial indication on web/mobile.
- [x] Add the idempotent preview/execute backfill using retained stage rows and provider semantics.
- [x] Re-run all focused tests and confirm they pass.

### Task 5: Final Verification

- [ ] Run `rtk pnpm migrate`.
- [ ] Run `rtk pnpm lint:migrations`, `rtk pnpm lint:analytics-sql`, and `rtk pnpm lint:analytics-policy`.
- [ ] Run `rtk pnpm lint`, `rtk pnpm tsc --noEmit`, `rtk pnpm --dir packages/server tsc --noEmit`, and `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`, `rtk pnpm test:integration`, and the mobile tier required by the touched code.
- [x] Regenerate schema diagrams and update current documentation.
- [ ] Commit, push, open a PR with `Fixes #2249`, monitor CI/reviews, address feedback, and squash-merge after every required check passes.
