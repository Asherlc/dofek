# Supplement Dose Events TDD Plan

**Goal:** Scheduled supplements remain plans until an append-only dose event
explicitly records what happened, and only current `taken` events contribute
nutrients.

**Behavior:** Each daily supplement occurrence is `planned`, `taken`, `skipped`,
or `unknown`, with provenance-preserving status history on web and mobile.
Per-user syncs materialize only that user's bounded schedule dates. Nutrition
serving views add nutrients from current `taken` leaves without treating
supplements as a competing full-day provider source.

**Scope:** Includes immutable supplement definition versions, stable schedule
identity, append-only linear dose-event supersession, source history,
timezone-aware bounded materialization, removal of historical fictional
`auto-supplements` food rows, canonical nutrition integration, and web/mobile
parity. It excludes adherence formulas, supplement importers, inferred `taken`
states, and duplicate nutrient snapshots.

**Docs:** [Database schema](../../schema.md),
[testing](../../testing.md), and
[canonical nutrition PR #2220](https://github.com/Asherlc/dofek/pull/2220).

---

## Current Evidence

- `AutoSupplementsProvider.sync()` ignores `run.options.userId`, reads every
  user's stack, and writes every scheduled date as a confirmed itemized
  `food_entry`.
- `food_entry.confirmed` defaults to true, so planned supplement nutrients flow
  through `v_nutrition_daily` and every downstream nutrition analysis.
- `supplements.save` deletes and recreates current definitions, which prevents
  stable occurrence identity or historical nutrient interpretation.
- Web and mobile tell users that configured daily supplements are synchronized
  as nutrition data; neither platform exposes occurrence status or history.
- `medication_dose_event` is provider-shaped and mutable during Apple import, so
  it is not an append-only supplement ledger.

## Test Strategy

- Unit: definition versioning, dose transitions, timezone/date helpers, strict
  user scoping, Zod boundaries, and user-facing status rendering.
- Integration: real PostgreSQL constraints, migration cleanup and cascade,
  cross-user isolation, bounded materialization, status supersession, and
  canonical nutrient behavior.
- UI/mobile/web parity: current status, actions, history/provenance, explicit
  loading/error/empty states, and stories for reusable panels.

## File Structure

- Modify `src/db/schema/nutrition.ts` and `src/db/schema/enums.ts` for immutable
  definition versions and dose events.
- Add the next `drizzle/` migration and journal entry for schema, serving views,
  and exact fictional-row cleanup.
- Rewrite `src/providers/auto-supplements.ts` as a per-user schedule
  materializer; update its unit and integration tests first.
- Extend `packages/server/src/repositories/supplements-repository.ts` and
  `packages/server/src/routers/supplements.ts` for versioned plans, status
  history, and append-only transitions.
- Update `packages/web/src/components/SupplementStackPanel.tsx` and
  `packages/mobile/app/supplements.tsx`, extracting story-backed schedule
  panels where useful.
- Update schema and supplement behavior documentation.

## Tasks

### Task 1: Prove the storage and serving contract

**Files:**
- Modify: `src/providers/auto-supplements.integration.test.ts`
- Create: `packages/server/src/repositories/supplement-dose-events.integration.test.ts`

- [ ] Write failing real-PostgreSQL tests proving a user A sync cannot create or
  advance user B events.
- [ ] Write failing tests for stable schedule identity and immutable definition
  versions.
- [ ] Write failing tests proving planned/skipped/unknown contribute zero,
  current taken contributes once, and a correction away from taken removes the
  contribution without deleting history.
- [ ] Write failing tests proving taken supplements remain additive alongside a
  resolved food source and do not trigger `source_conflict`.
- [ ] Write a failing migration test proving only
  `provider_id='auto-supplements'` food rows and cascading nutrients are
  removed.
- [ ] Run
  `pnpm test:integration -- src/providers/auto-supplements.integration.test.ts packages/server/src/repositories/supplement-dose-events.integration.test.ts`
  and confirm failures reflect missing schema/behavior.

### Task 2: Implement schema and migration

**Files:**
- Modify: `src/db/schema/nutrition.ts`, `src/db/schema/enums.ts`
- Create: next `drizzle/*.sql`
- Modify: `drizzle/meta/_journal.json`

- [ ] Add stable schedule identity, immutable definition version metadata, and
  partial active-definition uniqueness.
- [ ] Add the four-state append-only dose-event ledger with same-slot
  supersession, one root, one successor, provider provenance, and user-safe
  composite foreign keys.
- [ ] Add a current-leaf projection.
- [ ] Extend `v_nutrition_canonical_nutrient` and `v_nutrition_daily` so current
  taken supplement nutrients are an additive canonical overlay.
- [ ] Delete exactly the fictional `auto-supplements` food rows and rely on the
  existing nutrient cascade.
- [ ] Run migration lint, schema typecheck, and the focused real-PostgreSQL
  tests until green.

### Task 3: Rewrite schedule materialization

**Files:**
- Modify: `src/providers/auto-supplements.test.ts`
- Modify: `src/providers/auto-supplements.integration.test.ts`
- Modify: `src/providers/auto-supplements.ts`

- [ ] Write failing tests for mandatory `run.options.userId`, per-user reads and
  provider connection, effective-interval bounds, requested-window bounds,
  timezone rollover, idempotent planned roots, and past unknown transitions.
- [ ] Require a user identity and fail loudly when timezone/configuration values
  are invalid.
- [ ] Materialize current/future due dates as planned, past unresolved dates as
  unknown, and never infer taken.
- [ ] Remove all food-entry writes from the provider.
- [ ] Run unit, mutation, and focused integration tests.

### Task 4: Add server plan and occurrence APIs

**Files:**
- Modify: `packages/server/src/repositories/supplements-repository.test.ts`
- Modify: `packages/server/src/repositories/supplements-repository.ts`
- Modify: `packages/server/src/routers/supplements.test.ts`
- Modify: `packages/server/src/routers/supplements.ts`

- [ ] Write failing tests for active definition listing, archive-and-successor
  saves, current status/history reads, source provenance, access windows, and
  stale expected-event conflicts.
- [ ] Preserve stable schedule identity across definition edits.
- [ ] Append taken/skipped corrections transactionally against the expected
  current leaf; never update or delete event history.
- [ ] Return specific server errors and invalidate only supplement/nutrition
  query families.
- [ ] Run focused repository/router unit and integration tests.

### Task 5: Implement web and mobile parity

**Files:**
- Modify/create colocated tests and stories under `packages/web/src/components/`
  and `packages/mobile/components/`
- Modify: `packages/web/src/components/SupplementStackPanel.tsx`
- Modify: `packages/web/src/routes/nutrition/supplements.tsx`
- Modify: `packages/mobile/app/supplements.tsx`

- [ ] Write failing component tests for planned/taken/skipped/unknown display,
  taken/skip actions, source history, error messages, telemetry, and cached
  refresh behavior.
- [ ] Show current occurrence status and bounded recent history on both
  platforms without client-side metric computation.
- [ ] Replace the false “synced as nutrition data” language with explicit plan
  versus consumed-dose language.
- [ ] Add loading/error/empty/populated stories for reusable web and mobile
  components.
- [ ] Run web/mobile unit tests, Storybook typechecks, and package typechecks.

### Task 6: Final verification and publication

- [ ] Run `pnpm lint`, all workspace/package typechecks, `pnpm test`,
  focused integration tests, migration policy checks, and relevant mutation
  tests.
- [ ] Update `docs/schema.md`, provider docs, and any generated schema artifacts
  required by repository policy with primary-source citations.
- [ ] Commit intentionally, push, and open one PR with `Fixes #2064`.
- [ ] Link the PR from issue #2064, monitor every CI check, address all
  actionable review comments, and merge only at an exact-main clean green head
  with zero unresolved threads.
