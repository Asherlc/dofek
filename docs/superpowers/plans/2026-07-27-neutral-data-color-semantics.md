# Neutral Data Color Semantics TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop green/red status colors from assigning positive or negative value to neutral categories and raw data direction while preserving explicitly explained target evaluations.

**Behavior:** Web and mobile use the existing shared categorical/chart colors for macros and signed magnitudes, correlation confidence uses the existing neutral/info operational tones, and visible labels or spatial direction continue to communicate each value without relying on color alone.

**Scope:** Update macro, correlation, raw weight/body-composition, and monthly-trend presenters on their existing platforms. Preserve calorie-goal, Recommended Dietary Allowance (RDA), protein-intake recommendation, recovery/strain, application-state, and explicitly labeled next-day-readiness evaluations. Do not change server DTOs, domain thresholds, scoring logic, or add a palette.

**Docs:** [Issue #2080](https://github.com/Asherlc/dofek/issues/2080), [WCAG 2.2 SC 1.4.1: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), and [`packages/scoring/README.md`](../../../packages/scoring/README.md).

---

## Current Evidence

- Web macro categories use blue/amber/red while mobile uses success/warning/danger, assigning warning and danger meaning to carbohydrate and fat categories.
- Web and mobile correlation bars, trend lines, confidence badges, and conditional differences use green/red or success/warning/danger for statistical sign and magnitude even though correlation direction is not outcome valence.
- Web and mobile weight-rate presenters use green for gain and red for loss without evaluating the user's goal.
- Web body-composition deltas and monthly trend percentages use green/red based only on direction.
- The UI already renders labels, signs, axes, and directional bar placement, so those non-color cues remain available as required by WCAG SC 1.4.1.

## Test Strategy

- Unit: Assert each affected presenter uses only existing neutral categorical/info tokens for neutral categories or raw magnitude, independent of sign.
- Regression: Assert positive and negative signed values keep their sign, label, geometry, and values while sharing non-valence color semantics.
- UI/mobile/web parity: Assert the equivalent macro, correlation, and weight-rate surfaces use the same shared token choices on both platforms.
- Preservation: Keep existing tests for RDA/protein/calorie goals, score bands, operational states, and explicitly labeled HELPS/HURTS behavior outcomes unchanged.

## File Structure

- Modify: `packages/web/src/components/MacroBar.tsx` and colocated test/story.
- Modify: `packages/web/src/pages/NutritionPage.tsx`.
- Modify: `packages/mobile/components/MacroSummary.tsx`; add its colocated test.
- Modify: `packages/mobile/app/food/QuickAddTab.tsx`; add its colocated test.
- Modify: `packages/web/src/components/CorrelationStrengthBar.tsx`; add its colocated test.
- Modify: `packages/web/src/components/CorrelationCard.tsx` and colocated test.
- Modify: `packages/web/src/pages/CorrelationExplorerPage.tsx` and colocated test.
- Modify: `packages/mobile/app/correlation.tsx` and colocated test.
- Modify: `packages/web/src/components/SmoothedWeightChart.tsx`, `WeightPredictionSummary.tsx`, `BodyRecompositionChart.tsx`, and `MonthlyReportContent.tsx` with their colocated tests.
- Modify: `packages/mobile/app/(tabs)/recovery.tsx` and its colocated test.

## Tasks

### Task 1: Lock Macro Categories to Neutral Categorical Colors

**Files:**
- Modify: `packages/web/src/components/MacroBar.test.tsx`
- Create: `packages/mobile/components/MacroSummary.test.tsx`
- Create: `packages/mobile/app/food/QuickAddTab.test.tsx`

- [x] Write failing tests proving protein, carbohydrate, and fat categories use the shared blue/purple/teal chart colors rather than status colors.
- [x] Run `rtk pnpm exec vitest run --project unit packages/web/src/components/MacroBar.test.tsx --project mobile packages/mobile/components/MacroSummary.test.tsx packages/mobile/app/food/QuickAddTab.test.tsx`.
- [x] Confirm failures identify the current amber/red and success/warning/danger mappings.
- [x] Implement the minimum shared-token substitutions in the production presenters and update the web story inputs.
- [x] Rerun the focused tests and confirm they pass.

### Task 2: Make Correlation Sign, Magnitude, and Confidence Non-Valenced

**Files:**
- Create: `packages/web/src/components/CorrelationStrengthBar.test.tsx`
- Modify: `packages/web/src/components/CorrelationCard.test.tsx`
- Modify: `packages/web/src/pages/CorrelationExplorerPage.test.tsx`
- Modify: `packages/mobile/app/correlation.test.tsx`

- [x] Write failing tests proving positive and negative correlations share a neutral chart color while retaining sign and directional geometry.
- [x] Write failing tests proving confidence badges use only existing operational info/neutral tones.
- [x] Run `rtk pnpm exec vitest run --project unit packages/web/src/components/CorrelationStrengthBar.test.tsx packages/web/src/components/CorrelationCard.test.tsx packages/web/src/pages/CorrelationExplorerPage.test.tsx --project mobile packages/mobile/app/correlation.test.tsx`.
- [x] Confirm failures identify green/red and success/warning mappings.
- [x] Implement the minimum presenter changes with `chartColors` and `operationalStatusColors`.
- [x] Rerun the focused tests and confirm they pass.

### Task 3: Neutralize Raw Directional Magnitudes

**Files:**
- Modify: `packages/web/src/components/SmoothedWeightChart.test.tsx`
- Modify: `packages/web/src/components/WeightPredictionSummary.test.tsx`
- Modify: `packages/web/src/components/BodyRecompositionChart.test.tsx`
- Modify: `packages/web/src/components/MonthlyReportContent.test.tsx`
- Modify: `packages/mobile/app/(tabs)/recovery.test.tsx`

- [x] Write failing tests proving positive and negative weight, body-composition, and monthly-report changes do not receive success/danger semantics.
- [x] Run `rtk pnpm exec vitest run --project unit packages/web/src/components/SmoothedWeightChart.test.tsx packages/web/src/components/WeightPredictionSummary.test.tsx packages/web/src/components/BodyRecompositionChart.test.tsx packages/web/src/components/MonthlyReportContent.test.tsx --project mobile 'packages/mobile/app/(tabs)/recovery.test.tsx'`.
- [x] Confirm failures identify the sign-only green/red mappings.
- [x] Implement neutral shared-token styling while preserving signs, numbers, and chart/category identity.
- [x] Rerun the focused tests and confirm they pass.

### Task 4: Final Verification and Shipping

- [x] Run focused formatting/lint checks on every changed file.
- [x] Run root, server, web, and mobile TypeScript checks.
- [x] Run `rtk pnpm test`.
- [x] Run `rtk pnpm lint`; if SQLFluff alone requires unavailable local ClickHouse, retain the exact fatal evidence and run all remaining Docker-free policy gates separately.
- [ ] Update the existing issue with the plan and PR link.
- [ ] Commit, push, open one PR with `Fixes #2080`, and monitor all CI and review feedback without merging.
