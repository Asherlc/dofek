# Cycling Durability Implementation Plan

> **For agentic workers** Use the design and acceptance criteria below and the repository’s test-first workflow. The Architect reviews each bounded assignment from the Paseo Implementer before it advances.

**Goal** Add the approved cycling durability comparison to web and iOS using imported power and weight data.

**Architecture** Incremental ClickHouse analytics preserve the rolling effort candidates that can win for at least one minimum work level. The server applies date, access, riding setting, and weight eligibility, then returns the result and its evidence to both clients.

**Tech stack** ClickHouse, dbt, TypeScript, tRPC, React, and React Native.

**Design** [Cycling durability design](../specs/2026-11-21-cycling-durability-design.md).

## Scope and execution gate

- Date range, work thresholds, durations, and selection semantics follow the design. Use 300 seconds and 30 kJ/kg by default.
- Confirm the weight eligibility rule before writing behavior tests or product code. This plan proposes same-day direct measurement and an outdoor-only first release.
- Check the latest main CI status before implementation. Honor the current branch and the repository’s [development](../../development-environment.md#development-policy), [test](../../testing.md#test-policy), and [storage](../../schema.md#storage-and-ingestion-policy) policies.
- Run each failing test before writing its behavior, then rerun after the change. Review each working step, commit meaningful chunks, and push each commit after the required checks. Use the proven scope of earlier checks for later documentation-only edits.

## 1. Preserve eligible efforts with their prior work

**Files** Add `analytics/models/read_models/cycling_durability_effort.sql` and its executable fixture in `src/db/cycling-durability-effort.integration.test.ts`. Use the canonical sources and the elapsed-time integration and batching patterns in `analytics/models/read_models/activity_power_curve.sql` and `src/db/activity-power-curve-read-model.integration.test.ts`.

**Interface** A current row per user, canonical ride, and duration in `{10, 60, 300, 1200}`. Its ordered candidates carry elapsed start and end, average watts, prior joules, source member and provider identifiers, nullable device identifier, and sample coverage evidence. These rows use ride and power data independently of body weight, whose local date is resolved at request time.

- [ ] Add a real ClickHouse fixture with a strongest effort before the threshold, a weaker later effort, and an exact threshold reached by 200 W for 3,600 seconds. Assert 720,000 joules at the latter start and a qualifying later effort at exactly 10 kJ/kg for a 72 kg rider. Verify an effort cannot qualify using its own work. Include an observed zero in a continuous prefix.
- [ ] Add fixtures that isolate gaps before the effort, estimated power, null provenance, an explicit Strava meter flag from a different member of the same ride, and a source change halfway through. Assert that they cannot contribute qualifying candidates. Cover an incomplete ride, updated source evidence, and a soft deletion with a tombstone. Run the targeted fixture and confirm it fails against the existing model.
- [ ] Implement elapsed window means and prefix joules over `activity_sensor_sample` and the exact active source member. Preserve the deduped input and verify continuity from that source’s start through the candidate end, using the existing coverage semantics with the existing gap cap. Admit direct provenance and the exact member’s positive device-power flag. Honor explicitly estimated provenance. Use unrounded arithmetic and reject malformed observations before integrating across them.
- [ ] Retain a candidate when no candidate with at least as much prior work has greater average watts or wins the same-power tie. Within a ride, prefer higher prior work, then the earlier offset when the amount of work is also equal. Apply the comparison over the entire interval list before discarding candidates. Use bounded dirty-key builds and verify new rows, late-arriving samples, tombstones, and existing account-erasure coverage. This preserves exact answers for every threshold without reprocessing watt samples after a weight edit.
- [ ] Rerun the real-engine fixtures and analytics lint. Record query-log duration, peak memory, and retained candidate counts for a long ride and a long-history query. Confirm the SQL uses bounded batches and the serving path avoids a native-sample scan. Document the bounded historical build procedure in `analytics/README.md` using the existing patterns.

## 2. Serve the authenticated, weight-aware comparison

**Files** Add `packages/server/src/contracts/cycling-durability.ts`, `packages/server/src/repositories/cycling-durability-repository.ts` and its integration fixture. Register `cycling.durability` in `packages/server/src/routers/cycling.ts`. Reuse chart ranges, access windows, and `nearby-weight-repository.ts` for canonical weight observations.

**Interface** `cycling.durability` accepts the existing selected chart `days`, `durationSeconds` in `{10, 60, 300, 1200}` and `minimumWorkKilojoulesPerKg` in `{10, 20, 30, 40, 50}`. The server returns a date range, a status (`available`, `no_eligible_power_and_weight`, or `no_effort_after_work`), baseline and post-work efforts when available, and the presentation unit, value difference, and work cutoff. Each effort includes its activity ID and name, local date and UTC timestamp, elapsed start and end, watts and W/kg, prior work in kJ and kJ/kg, and power, coverage, and weight provenance.

- [ ] Add real-engine selection fixtures for an exact threshold, two different body weights whose absolute and relative rankings disagree, one winning effort that also wins the baseline, and a late effort with no qualifying baseline input. Cover accessible history limits, a local-day boundary, indoor and virtual exclusion, another user’s records, missing or nonmatching weight, correction to a weight value, and a scope with eligible baseline but no late effort. Confirm the test fails before the implementation.
- [ ] Select canonical same-day measured weights by the approved rule. Pass the per-date weight evidence to the ClickHouse selection as typed input and keep candidate arrays on the database side. Choose winners by unrounded W/kg after applying the work threshold independently of the baseline. Apply both selections to the same eligible data. Use stable ordering by relative power, UTC start, and activity ID across rides. Return raw and normalized values and the server-computed difference. Withhold the absolute kJ cutoff unless all qualifying weights agree. Use the existing selected chart range and authentication helpers, validate query rows and responses, and confirm a weight correction changes selection without rebuilding power data.
- [ ] Rerun the repository, router, and real ClickHouse fixtures. Verify a result cannot be retrieved outside the caller’s ownership, access range, or the selected modality. Compare the normalizing and rendering behavior against the design.

## 3. Render the comparison on web and iOS

**Files** Add colocated `CyclingDurability` components and stories in `packages/web/src/components/` and `packages/mobile/components/`. Use the existing entry points in `packages/web/src/routes/training/cycling.tsx` and `packages/mobile/app/strain.tsx` and extend the relevant route tests. Use the existing date range and query-state patterns.

- [ ] Add focused red tests for the 320 W and 296 W sample with the 24 W difference, the different-weight case, the no-matching-effort case, and controls that pass the active date range, duration, and prior work. Exercise the ride evidence disclosure and an API error. Verify the iOS panel loads only on Cycling and that web and iOS show the same returned values.
- [ ] Place the panel below the web Power Duration Curve and between Vertical Ascent Rate and Cycling Volume on iOS. Use the design’s **Power after sustained riding**, **Best at any point in a ride**, **Change comparison**, and **See the rides behind these numbers** labels. Keep the evidence inspectable and let the existing query UI handle stale values during refetch. Use server-authored values, including the normalized headline when applicable.
- [ ] Run the focused tests and inspect the stories at desktop and iOS widths. Check keyboard or accessibility navigation, the explanation of kJ, and both disclosures. Inspect loading, available, and empty states and the location of the panel relative to its neighboring charts. Verify the normal route uses the same presentation.

## Final review

- [ ] Review the full change against the design and scope. Record the red/green evidence, real-engine checks, and separate final review. Review duplicate ownership, missing observations, arbitrary long histories, source changes, exact threshold equality, and weight corrections.
- [ ] Run `pnpm lint`, `pnpm --recursive --include-workspace-root --if-present typecheck`, relevant noninteractive unit and mobile suites, and the real-engine integration suite for the new model and repository. Run the analytics SQL and policy lint commands. Confirm the focused local and required remote checks before reporting readiness.
