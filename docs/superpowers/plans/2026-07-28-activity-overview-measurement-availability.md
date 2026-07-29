# Activity Overview Measurement Availability TDD Plan

**Goal:** Preserve the distinction between unavailable activity distance/elevation and an actual measured zero from ClickHouse through the API to web and mobile.

**Behavior:** Activity overview distance and elevation are nullable server-owned totals. When no activity has an aggregatable measurement, web and mobile show “Distance not recorded” and “Elevation unavailable.” When at least one measurement is present and the aggregate is zero, both clients render the formatted zero.

**Scope:** Issue [#2119](https://github.com/Asherlc/dofek/issues/2119) only. Includes the canonical compact ClickHouse distance/elevation summaries, activity overview repository/API contract, equivalent web/mobile wording, and a manual bounded repair for historical legacy-zero compact rows. Excludes the compatibility `activity_summary` model and its other consumers, activity-detail cards, ingestion changes, new fallback calculations, client-side metric derivation, and automatic production backfill execution.

**Docs:** ClickHouse documents that the [`-OrNull` aggregate combinator](https://clickhouse.com/docs/reference/functions/aggregate-functions/combinators#-ornull) returns `NULL` when there is nothing to aggregate.

---

## Current Evidence

- `activity_location_summary_rows` and `activity_sensor_summary_rows` coalesce missing distance/elevation inputs to zero.
- `ActivitiesCalendarRepository.getActivityOverview()` reads the compatibility activity summary, again coalesces missing values to zero, and exposes non-null numeric fields.
- The calendar router output schema and both Activities overview clients therefore receive only numbers and format missing measurements as `0.0 km` and `0 m`.

## Test Strategy

- Unit: prove repository and router contracts preserve `null` and literal zero independently.
- Integration: run faithful one-row-per-activity compact summaries against real ClickHouse fixtures, proving an activity without GPS/altitude returns nullable overview totals while flat measured GPS/altitude samples aggregate to zero.
- UI parity: prove web and mobile render the requested unavailable wording for `null`, while formatting a server-provided zero normally.

## File Structure

- Modify `analytics/models/read_models/activity_location_summary_rows.sql` - preserve unavailable GPS distance.
- Modify `analytics/models/read_models/activity_sensor_summary_rows.sql` - preserve unavailable elevation.
- Modify `packages/server/src/repositories/activities-calendar-repository.ts` and tests - expose nullable aggregate totals with `sumOrNull`.
- Modify the isolated ClickHouse integration helpers - execute the compact summary semantics used by the repository.
- Modify `packages/server/src/repositories/activity-visibility-consistency.integration.test.ts` - executable ClickHouse regression.
- Modify `packages/server/src/routers/calendar.ts` and tests - nullable output contract.
- Modify `packages/web/src/pages/ActivitiesPage.tsx` and test - web wording.
- Modify `packages/mobile/app/(tabs)/activities.tsx` and test - mobile wording.
- Add `packages/format/src/activity-overview.ts` and test - shared availability copy and null-versus-number rendering.
- Add `src/db/activity-overview-availability-backfill.ts`, its CLI, executable ClickHouse coverage, and an operator runbook - repair bounded historical legacy-zero rows.

## Tasks

### Task 1: Add Failing Server and ClickHouse Tests

- [x] Add repository cases for unavailable totals, empty overview, and literal zero.
- [x] Change the real ClickHouse visibility fixture to require `null` without aggregatable samples and `0` with flat measured samples.
- [x] Add a router contract case returning nullable totals.
- [x] Run `pnpm exec vitest run --project unit packages/server/src/repositories/activities-calendar-repository.test.ts packages/server/src/routers/calendar.test.ts`.
- [x] Run `pnpm test:integration -- packages/server/src/repositories/activity-visibility-consistency.integration.test.ts`.
- [x] Confirm both tiers fail for the expected zero-coercion reasons.

### Task 2: Implement the Canonical Server Fix

- [x] Remove model-level defaults that turn absent GPS/altitude aggregates into zero.
- [x] Use `sumOrNull` in the overview query and make repository/router fields nullable.
- [x] Preserve numeric zero without special-casing it.
- [x] Re-run the focused server unit and integration commands and confirm they pass.

### Task 3: Add Failing Web and Mobile Parity Tests

- [x] Add web assertions for unavailable wording and measured zero.
- [x] Add mobile assertions for the same wording and measured zero.
- [x] Run `pnpm exec vitest run --project unit packages/web/src/pages/ActivitiesPage.test.tsx`.
- [x] Run `pnpm exec vitest run --project mobile 'packages/mobile/app/(tabs)/activities.test.tsx'`.
- [x] Confirm both fail because clients still assume numeric totals.

### Task 4: Implement Minimal Client Rendering

- [x] Render exact unavailable wording only when the corresponding server field is `null`.
- [x] Continue formatting every numeric value, including zero, through the existing unit converter.
- [x] Re-run focused web/mobile tests and confirm they pass.

### Task 5: Final Verification

- [x] Run relevant lint, typecheck, unit, integration, Storybook/build, and diff checks.
- [x] Review the complete diff against the exact issue base.
- [ ] Commit, push, and open one PR containing `Fixes #2119`.

### Task 6: Address Review Findings

- [x] Move shared availability wording and null-versus-number rendering into `@dofek/format` while clients retain unit conversion.
- [x] Add a dry-run-first TypeScript backfill with mandatory UTC bounds and explicit `--execute`.
- [x] Preserve the full latest compact row and assign a strictly newer replacement version.
- [x] Rewrite distance and elevation independently only when fewer than two valid samples exist.
- [x] Prove exclusive bounds, dry-run behavior, execution, idempotency, and measured-zero preservation against real ClickHouse.
- [x] Document the manual operator workflow without adding it to deploy or request paths.
