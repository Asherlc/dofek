# Metric Card Drill-downs TDD Plan

**Goal:** Make important web and iOS metric cards explicitly navigate to the existing records or source-evidence surfaces behind their values.

**Behavior:** Cards with an honest contributor destination show an accessible `View data` action. Resting-heart-rate actions open the by-source readings, sleep actions open nightly/source evidence, and expandable dashboard summary cards expose their existing recovery, activity, and sleep detail pages.

**Scope:** Reuse current routes and server-computed values. Do not add a generic raw-record framework, client-side metric calculations, or new record-edit/exclusion mutations.

**Docs:** [Issue #2091](https://github.com/Asherlc/dofek/issues/2091)

---

## Current Evidence

- The reusable iOS `MetricCard` renders a value and trend but has no action slot.
- Web `DailyOverview`, `DashboardEvidenceOverview`, `SleepPerformanceCard`, and `SleepNeedCard` expose computed values without an explicit evidence action.
- Existing destinations already expose the relevant evidence: Heart Rate by Source, Sleep Data Sources/recent nights, Correlation Explorer paired observations, Activities, and recovery detail.

## Test Strategy

- Unit: assert actions are absent by default, visible when configured, accessible, and invoke or point to the intended destination.
- UI parity: cover both web and iOS card paths and update their existing Storybook states.
- Runtime: exercise the web links and software-only iOS navigation if the local signed Simulator stack is available after all static checks pass.

## File Structure

- Modify `packages/mobile/components/MetricCard.tsx` and colocated tests/stories for the optional action.
- Modify mobile recovery/sleep screens and tests/stories to wire existing contributor destinations.
- Modify web dashboard/sleep card components and colocated tests/stories to expose existing contributor destinations.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add component tests for absent and configured iOS metric-card actions.
- [ ] Add mobile screen tests for resting-heart-rate and sleep drill-down behavior.
- [ ] Add web component tests for dashboard and sleep evidence links.
- [ ] Run focused Vitest commands and confirm failures are caused by missing actions.

### Task 2: Implement the Minimum Actions

- [ ] Add the optional iOS `MetricCard` action without changing metric computation.
- [ ] Wire resting-heart-rate and sleep cards to existing contributor screens/history.
- [ ] Add explicit web links only where the destination already exposes supporting data.
- [ ] Update Storybook variants for every modified component/screen.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Final Verification

- [ ] Run `pnpm lint`.
- [ ] Run root, server, web, and mobile TypeScript checks.
- [ ] Run relevant unit/mobile tests and the Docker-free full test tier.
- [ ] Run both Storybook builds.
- [ ] Commit, push, open a linked PR, and monitor reviews and required CI through merge.
