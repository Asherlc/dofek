# Unified Cycling Power Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate one computed-only cycling power implementation and migrate every FTP consumer to it.

**Architecture:** `@dofek/cycling-power` contains dependency-free TypeScript algorithms with explicit caller-supplied policies/reference curves. Dofek owns calibration data, contracts and a single serialized ClickHouse projector. dbt prepares canonical inputs before projection and builds dependent healthspan models afterward; repositories read projections or call the same package for bounded intervals. Clients render server results.

**Tech Stack:** Pure TypeScript workspace package, ClickHouse application projections, dbt, Zod, Vitest.

**Spec:** [Computed cycling eFTP](../specs/2026-11-01-computed-cycling-eftp-design.md).

## Global Constraints

- Computed eFTP only; remove both manual FTP columns and all writers/readers.
- No derived analytics written to Postgres.
- No duplicate TypeScript runtime NP, power TSS, or FTP estimators.
- Zero power remains observed; incomplete power coverage remains unavailable.
- Chronological activity thresholds cannot depend on future rides or display filters.
- Original CC0 calibration only; independent policy must not claim Intervals numerical parity.
- Both clients expose computed provenance and availability.
- Schema-only migrations; historical repair is a separately bounded operator action.

## Review Focus

- Same-day activities: later evidence must not rewrite earlier thresholds.
- Deleted or corrected historical peaks: replay later user history.
- Five-second samples, native zeros, gaps and fractional timestamps: preserve elapsed coverage.
- Missing power versus observed rest: missing load must not cause decay.
- Power-only cycling: retain canonical TSS in calendar and PMC without heart rate.

## Task 1: Package and numerical kernels

**Files:** `packages/cycling-power/{package.json,tsconfig.json,README.md,AGENTS.md,src/power.ts,src/power.test.ts,src/threshold.ts,src/threshold.test.ts,src/critical-power.ts,src/critical-power.test.ts,src/regression.ts,src/regression.test.ts}`; root/server dependency declarations and Docker package handling.

**Interfaces:** Pure functions for normalized power, power dose, IF/TSS, reference interpolation and chronological projection; coverage, fit, threshold and history policies are required caller inputs. Dofek data, database dependencies and wire contracts are excluded.

- [x] Write pure numerical tests for zeros, full 30-second windows, native cadence, fractional coverage, gaps, missing thresholds, qualifying reference efforts, chronological carry-forward and decay.
- [x] Run tests and observe missing-algorithm failures.
- [x] Implement pure algorithms; place the frozen original-source bank and independent decay policy in application code.
- [x] Run numerical tests and package typecheck; check reference-range admission, generic ID determinism and explicit unavailable results.
- [x] Commit and push package with verification evidence.

## Task 2: Canonical history and lifecycle

**Files:** `src/analytics/cycling-power-projector.ts`, application policy/reference data, `src/db/cycling-power-schema.ts`, migration 0108 and serialized analytics processing/queue completion.

**Interfaces:** `analytics.cycling_threshold_history` exposes user/event time, activity ID, nullable eFTP, evidence activity/time/duration/power and model version. `analytics.cycling_activity_power_metrics` exposes user/activity/start time, NP/eFTP/IF/power TSS and the same evidence.

- [x] Seed minimal actual-engine canonical activity, curve and summary fixtures; assert activity-date isolation, replay after peak correction/deletion and inactive-day progression.
- [x] Observe failure before model/view implementation.
- [x] Implement bounded dirty-user replay over compact summaries, chronological tie ordering and date progression. Use only package algorithms. Refresh at most 100 changed native observations and 32 ready user histories per pass; remove SQL NP storage/formulas and expose the canonical observation through serving views.
- [x] Run integration fixtures and analytics lint.
- [x] Commit and push validated lifecycle changes.

## Task 3: Server consumers and manual-setting removal

**Files:** Threshold/history/current power, advanced/performance, workout/interval, PMC, calendar, analytical-load repositories; sport settings; MCP contracts; Postgres/raw CDC schema and migrations.

**Interfaces:** `CyclingThresholdRepository(store,userId,timezone)` provides `getCurrent()`, `getAsOf(timestamp)`, `getForActivities(ids)` and paginated history. Consumers receive canonical activity TSS and historical eFTP rather than calculating substitutes.

- [x] Write failing behavioral tests for per-activity thresholds, power-only PMC, calendar TSS and computed evidence.
- [x] Migrate all audited consumers, including interval NP, to canonical results/functions; delete obsolete math and method selectors.
- [x] Remove manual schema/API fields and former tests; add no absence tests.
- [x] Run focused suites and typecheck; inspect remaining FTP/NP/TSS formulas.
- [x] Commit and push validated consumer migration.

## Task 4: Both clients and deployment verification

**Files:** Web/mobile activity and cycling threshold surfaces; README/runbook updates.

- [x] Write paired rendering/interaction tests for computed evidence and unavailable results.
- [x] Render the same server-owned value/provenance on both platforms; distinguish CP exploration from ongoing eFTP.
- [x] Run unit/mobile, relevant integration, typecheck and lint checks. Review migration ordering and bounded historical-refresh procedure.
- [x] Obtain fresh whole-branch review, fix material findings with regressions, commit and push.

## Working ledger

- User authorization: “Implement and isolate in a package” follows review of the research/design and authorizes execution without another strategy-selection round.
- Ruling: user explicitly selected pure TypeScript with no database dependency. Application orchestration calls the package and owns persistence; dbt supplies inputs and downstream projections. There is no SQL numerical counterpart.
- Ruling: independent decay is explicit versioned Dofek policy (maximum 0.1% daily after 28 observed days, comparing completed 14-day dose windows), not a recovered Intervals formula or physiological constant; unknown power withholds decay. Reference fitting uses the frozen original-CC0 bank, with unsupported tails unavailable and uncertainty unquantified.
- Review checkpoints: kernel tests; lifecycle integration tests; consumer/typecheck gate; fresh final review.

## Verification ledger

- Pure package numerical regressions, per-activity consumer tests, paired UI tests and real-engine projector/migration/publication tests have passed.
- Fresh whole-branch review found two material issues: interval null barriers could diverge from activity coverage, and future/in-progress imports could be marked fresh before becoming eligible. Both were fixed with failing-then-passing regressions; the shared resampler and completion gate are now canonical. Fractional offsets remain supported; durations explicitly require integer seconds.
- Calendar consumer integration: 6/6 pass on minimal current-schema fixtures. Healthspan elapsed coverage, unknown intensity, older corrected weeks and deletion dates: 5/5 pass. Migration 0175 selects the existing maintenance deployment mode.
- Package release artifact: 13 files, zero dependencies; clean Node runtime and strict TypeScript consumer checks passed. Package tests: 77/77. Build, sandbox lint and analytics SQL lint passed.
- Full unit/mobile rerun: 1,469 files and 24,013 tests passed; 2 files / 19 tests skipped, zero failures. Root/server/web/mobile typechecks and final diff checks passed. Source commit/push follows this verification checkpoint. npm publication is authorized but currently awaits npm browser authentication; no application deployment is authorized or performed.
