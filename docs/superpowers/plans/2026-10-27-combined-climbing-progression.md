# Combined climbing progression implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track steps and review checkpoints here.

**Goal:** One grade-colored stack per period for every selected type and setting.

**Architecture:** Pool raw entries in the server builder and expose one nullable
chart object. Web and mobile render the same computed contract; page filtering
continues to select records before projection.

**Tech Stack:** Existing TypeScript, Zod, Vitest, ECharts, react-native-svg.

**Spec:** [Approved design](../specs/2026-10-27-combined-climbing-progression-design.md).

## Global constraints

- All metric calculation stays on the server. No new dependency or compatibility path.
- Keep this branch; commit and push verified work automatically.
- Retain existing saved grade preferences, distinct boulder/route and retained source scales, loading/error/empty states, and accessible exact values.

## Review focus

- A day shared by types/settings counts once; fixture must include both overlaps.
- Identical grade labels on different scales remain distinct grade keys.
- Failed/unknown results contribute days, and empty periods remain null rates.
- Filter changes reach the builder and mobile caches cannot restore the old shape.
- Mobile selected-period details update with refreshed response values.

### Task 1: Combined server contract and computation

Files: training `climbing-progression.ts` and test; server builder, repository,
router, mobile training service, dashboard contracts, related tests/fixtures.

Interface: `climbingGradeProgressionSchema` validates `ClimbingGradeProgressionData`.
Fields: grades `{key,climbKind,gradeSystem,grade,gradeSortValue}`; axisMax,
axisInterval, axisTicks; periods `{startDate,endDate,climbingDays,sends,
unknownOutcomes,sendsPerDay,segments}` with segments `{gradeKey,sends,sendsPerDay,
stackStart,stackEnd}`. Empty query returns null. Shared grade labels qualify collisions.

- [x] Write failing mixed-kind/method/setting aggregation and distinct-day tests.
- [x] Run the tests red, implement pooling before rates, then run green.
- [x] Migrate every server consumer and cache contract; retain lane key used by strengths.
- [x] Review server behavior and contract changes against the spec.

### Task 2: Web presentation

Files: web GradeProgressionChart, tests, fixture helper, stories and climbing route.
Consumes the Task 1 nullable object; emits one stack of server grade series.

- [x] Write a failing test for one mixed-grade chart with server rates.
- [x] Render one chart/legend/table; retain zero/missing indicators and tooltips.
- [x] Update page and story fixtures, run focused tests/typecheck/lint.
- [x] Review wide and narrow Storybook layouts.

### Task 3: Mobile presentation and final integration

Files: mobile GradeProgressionChart, TrainingCard parser, fixtures, tests, stories,
and query persistence contract where needed. Consumes the same nullable object.

- [x] Write a failing combined-chart behavior test and preserve refreshed details coverage.
- [x] Render one SVG and accessible disclosure; migrate parser and cache fixtures.
- [x] Run affected mobile tests and typecheck.
- [x] Independently review complete diff, run final checks, then commit and push.
