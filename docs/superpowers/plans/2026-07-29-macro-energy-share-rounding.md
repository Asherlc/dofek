# Macro Energy Share Rounding TDD Plan

**Goal:** Make selected-day macronutrient energy shares unambiguous and guarantee that
non-empty protein, carbohydrate, and fat shares total exactly 100%.

**Behavior:** The server normalizes macro-derived calories, applies deterministic
largest-remainder rounding with protein/carbohydrate/fat as the stable tie order, and
returns `energySharePercentage` for each macro. Web and iOS render those server-owned
values under a “Share of energy” label while presenting logged grams as a separate
quantity. Empty macro data returns three zero shares.

**Scope:** The selected-day nutrition summary contract, its repository computation,
the web nutrition macro rows, the iOS nutrition macro summary, their tests, and their
Storybook states. Calorie-goal behavior, new gram targets, and nutrition analytics are
out of scope.

**Docs:** [GitHub issue #2131](https://github.com/Asherlc/dofek/issues/2131)

---

## Current Evidence

- `packages/server/src/repositories/food-repository.ts` independently rounds each
  macro-derived calorie count against the daily calorie total.
- Independent rounding does not preserve a 100% total, and the daily calorie total can
  differ from the calories implied by macro grams.
- `packages/web/src/components/MacroBar.tsx` presents the percentage as a progress-like
  track beside grams without naming its meaning.
- `packages/mobile/components/MacroSummary.tsx` shows grams but omits the corresponding
  server-owned energy share.

## Test Strategy

- Unit: exercise the repository public API with a 103%-style fixture, a fractional
  tie, and empty macros; validate the renamed shared schema.
- Web: verify visible “Share of energy” context, separate percentage/gram copy, exact
  accessible meter labels, and server-owned widths.
- Mobile: verify equivalent visible context and exact accessible labels for the
  server-owned shares and logged grams.
- Integration: update the existing real-Postgres food router expectation to cover the
  canonical response field and normalized shares.
- Stories: add representative non-even rounding states on both platforms.

## File Structure

- Modify: `packages/server/src/repositories/food-repository.ts` - allocate normalized
  macro shares on the server.
- Modify: `packages/server/src/repositories/food-repository.test.ts` - repository
  behavior and rounding boundaries.
- Modify: `packages/server/src/routers/food.integration.test.ts` - executable response
  contract.
- Modify: `packages/nutrition/src/selected-date-summary.ts` and colocated test - rename
  and constrain the canonical contract.
- Modify: `packages/web/src/components/MacroBar.tsx`, test, and stories - explicit web
  energy-share rendering.
- Modify: `packages/web/src/pages/NutritionPage.tsx` and affected fixtures - label the
  macro section and consume the canonical field.
- Modify: `packages/mobile/components/MacroSummary.tsx`, test, and stories - equivalent
  iOS rendering and accessibility.
- Modify: affected mobile fixtures - consume the canonical field.

## Tasks

### Task 1: Add Failing Server and Contract Tests

- [ ] Add repository cases proving the 103%-style input becomes a deterministic 100%
  allocation, equal remainders use stable macro order, and empty macros remain zero.
- [ ] Rename the canonical field expectation to `energySharePercentage` and constrain it
  to 0–100.
- [ ] Run `rtk pnpm test -- --run packages/server/src/repositories/food-repository.test.ts packages/nutrition/src/selected-date-summary.test.ts`.
- [ ] Confirm failures show the existing independent rounding and old response field.

### Task 2: Implement Minimal Server Fix

- [ ] Normalize the three macro-derived energy values and allocate integer shares using
  the largest-remainder method with a documented stable tie order.
- [ ] Return only the canonical `energySharePercentage` field.
- [ ] Update the existing integration expectation.
- [ ] Run `rtk pnpm test -- --run packages/server/src/repositories/food-repository.test.ts packages/nutrition/src/selected-date-summary.test.ts`.
- [ ] Run `rtk pnpm test:integration -- --run packages/server/src/routers/food.integration.test.ts`.
- [ ] Confirm the focused tests pass.

### Task 3: Add Failing Web and Mobile Tests

- [ ] Assert explicit “Share of energy” context and separately labeled grams on web.
- [ ] Assert exact accessible meter labels and server-owned widths on web.
- [ ] Assert equivalent visible context and exact accessible labels on mobile.
- [ ] Run `rtk pnpm test -- --run packages/web/src/components/MacroBar.test.tsx packages/mobile/components/MacroSummary.test.tsx`.
- [ ] Confirm failures identify the ambiguous/missing UI.

### Task 4: Implement Web and Mobile Parity

- [ ] Render the server-owned energy share and logged grams as distinct values on both
  platforms.
- [ ] Add exact accessible labels and preserve neutral categorical colors.
- [ ] Update both Storybook states with a fractional-allocation example totaling 100%.
- [ ] Run the focused UI tests and confirm they pass.

### Task 5: Final Verification

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Run relevant Storybook catalog/build validation.
- [ ] Commit, push, open a linked PR with `Fixes #2131`, address review feedback and CI
  root causes, and merge only after all required checks pass.
