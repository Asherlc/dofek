# Discrete Behavior Chart TDD Plan

**Goal:** Render boolean journal observations without visually inventing fractional behavior
values between recorded days.

**Behavior:** The web Tracking trends chart displays boolean answers as isolated Yes/No points
while numeric observations remain line series. Tooltips and the chart accessibility description
name boolean values as Yes/No. The separately computed behavior/readiness association remains
unchanged on web and iOS.

**Scope:** Web chart semantics, regression tests, and the Tracking Storybook fixture. The existing
server contracts already distinguish boolean and numeric journal observations, so this change does
not alter storage, API queries, or readiness calculations. Mobile has no Journal trends chart; its
existing behavior-association screen continues to render the server-computed outcome comparison.

**Docs:** ECharts supports separate
[scatter series](https://echarts.apache.org/handbook/en/how-to/chart-types/scatter/basic-scatter/)
for point observations and
[ARIA descriptions](https://echarts.apache.org/handbook/en/best-practices/aria/) for chart
accessibility.

---

## Current Evidence

- `journal.entries` returns each observation's `data_type` and exact `answer_numeric` value.
- `JournalPanel` currently sends every non-null numeric answer to `TimeSeriesChart` as the same
  series kind.
- `TimeSeriesChart` currently builds every series with `dofekSeries.line`, whose default is
  `smooth: true`; a sparse sequence of `0` and `1` answers therefore draws fractional curves.
- A step line would also imply that the prior answer remained in effect across unrecorded days.
  Isolated points preserve the actual observation grain.

## Test Strategy

- Unit: verify `TimeSeriesChart` maps point and line inputs to scatter and line ECharts series,
  formats boolean values as Yes/No, and provides an accessible chart description.
- Component: verify `JournalPanel` classifies mixed server-provided boolean and numeric questions
  into point and line series without transforming their values.
- Storybook: include mixed boolean and numeric observations in the Tracking trends fixture.
- Mobile parity: run the existing behavior-association screen tests to confirm the separate
  server-computed outcome surface remains intact.

## File Structure

- Modify: `packages/web/src/components/TimeSeriesChart.test.ts` — chart-series regression tests.
- Modify: `packages/web/src/components/JournalPanel.test.tsx` — mixed observation classification.
- Modify: `packages/web/src/components/TimeSeriesChart.tsx` — explicit point-series support.
- Modify: `packages/web/src/components/JournalPanel.tsx` — server-data-type visualization mapping.
- Modify: `packages/web/src/components/JournalPanel.stories.tsx` — mixed trends visual fixture.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add a mixed point/line option test to `TimeSeriesChart.test.ts`.
- [ ] Add a mixed boolean/numeric classification test to `JournalPanel.test.tsx`.
- [ ] Run
  `rtk pnpm test -- --run packages/web/src/components/TimeSeriesChart.test.ts packages/web/src/components/JournalPanel.test.tsx`.
- [ ] Confirm failure because explicit point-series semantics do not exist yet.

### Task 2: Implement Minimal Fix

- [ ] Add explicit line/point series mapping and an accessibility description to
  `TimeSeriesChart`.
- [ ] Map server-provided boolean questions to points with Yes/No formatting in `JournalPanel`.
- [ ] Keep numeric questions as line observations and update the Storybook fixture.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Final Verification

- [ ] Run `rtk pnpm lint`.
- [ ] Run root, server, web, and mobile typechecks.
- [ ] Run `rtk pnpm test`.
- [ ] Run the web Storybook build and the mobile behavior-association screen test.
- [ ] Push the linked branch, open a PR with `Fixes #2156`, monitor CI and reviews, and merge only
  after all required checks pass.
