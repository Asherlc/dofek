# Nutrition Aggregate Label TDD Plan

> **For agentic workers:** Write and run the failing tests before each production change.

**Goal:** Explain provider-owned daily nutrition aggregates and source-resolution decisions without presenting aggregate rows as editable meals.

**Behavior:** A reported-source day exposes a server-authored contribution label, grain, resolution message, and excluded-source provenance. Web and mobile render the same information. Source conflicts remain alerts with unavailable totals.

**Scope:** Extend the canonical Postgres view and selected-date server contract, then render the contract on web and mobile. Keep aggregate rows out of meal-entry cards and preserve raw provider rows.

**Docs:** [Canonical nutrition package](../../../packages/nutrition/README.md), [issue #2133](https://github.com/Asherlc/dofek/issues/2133)

---

## Current Evidence

- `fitness.v_nutrition_display_entry` excludes `daily_aggregate` rows, removing the misleading editable “Unnamed nutrition entry.”
- `fitness.v_nutrition_daily_resolution` computes `contribution_grain`, but `fitness.v_nutrition_daily` and `food.byDateV2` drop it.
- Available source-resolution decisions are not rendered by either client.
- Current source labels use raw provider IDs instead of canonical provider names.

## Test Strategy

- Unit: shared schema and server repository mapping, including server-authored contribution labels.
- Integration: execute the canonical views in Postgres and verify source/grain/overlap semantics.
- UI/mobile/web parity: public screen tests verify one informational panel per reported-source day and preserved conflict-alert behavior.

## File Structure

- Create `drizzle/0065_nutrition_resolution_labels.sql` — human-readable source labels and exposed contribution grain.
- Modify `packages/nutrition/src/selected-date-summary.ts` — resolution DTO contract.
- Modify `packages/server/src/repositories/food-repository.ts` — map canonical grain to a server-authored contribution label.
- Modify web/mobile nutrition screens and fixtures — render, do not recompute, resolution metadata.

## Tasks

### Task 1: Add Failing Contract Tests

- [ ] Add executable Postgres assertions for source labels, contribution grain, and excluded-source provenance.
- [ ] Add repository/router assertions for `contributionGrain` and `contributionLabel`.
- [ ] Run `rtk pnpm test:integration -- --run packages/server/src/repositories/nutrition-canonical.integration.test.ts`.
- [ ] Confirm failures identify the missing view and DTO fields.

### Task 2: Add Failing Client Tests

- [ ] Add web and mobile tests for an aggregate-only resolution panel.
- [ ] Assert aggregate rows are not rendered as editable meal entries.
- [ ] Confirm tests fail because available resolution metadata is not rendered.

### Task 3: Implement Minimal Fix

- [ ] Add the forward migration and shared/server contract fields.
- [ ] Render the server-authored label, exact message, and excluded source labels on both clients.
- [ ] Update stories/fixtures required by the contract.
- [ ] Run the focused tests and confirm they pass.

### Task 4: Final Verification

- [ ] Run relevant lint, typecheck, unit, integration, and story validation.
- [ ] Commit, push, open a linked PR with `Fixes #2133`, and monitor all checks/reviews through merge.
