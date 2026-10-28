# Combined climbing progression implementation plan

Work through the server projection, web presentation, and mobile integration in
order. Record validation results at each review checkpoint below.

**Goal:** One grade-colored stack per period for every selected type and setting.

**Architecture:** Pool raw entries in the server builder and expose one nullable
chart object through permanent V2 procedures. Preserve the existing V1 procedures
and complete lane response contracts for older clients. Current web and mobile
clients render the same V2 computed contract; page filtering selects records
before projection.

**Tech Stack:** Existing TypeScript, Zod, Vitest, ECharts, react-native-svg.

**Spec:** [Approved design](../specs/2026-10-27-combined-climbing-progression-design.md).

## Global constraints

- All metric calculation stays on the server. No new dependency, temporary alias, or client fallback.
- Preserve supported V1 contracts while current clients explicitly select V2.
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

### Task 4: Preserve supported V1 contracts and add permanent V2 procedures

Files: shared V1 progression schema; server projections, models, repository,
training service, contracts, routers, cache registry and tests; web/mobile query
calls, transport selection, invalidation, fixtures, stories and tests.

Interfaces: `climbing.gradeProgression` and `mobileDashboard.training` keep the
complete V1 lane-array contract. `climbing.gradeProgressionV2` returns the current
combined object or null; `mobileDashboard.trainingV2` uses that object within its
training response. The existing combined shared schema remains the V2 schema.

- [x] Write failing V1/V2 public response and client routing/invalidation tests.
- [x] Share raw observation retrieval and preserve genuine per-version denominators.
- [x] Expose separately typed procedures and migrate current clients to V2.
- [x] Verify V1 empty/populated arrays and V2 empty/populated objects through real queries.
- [x] Run focused server/shared/web/mobile suites, typechecks and lint; independently review.

Review checkpoint: both versions share one raw observation query per request.
The V1 projection retains its complete lane identities, setting-specific periods
and denominators; V2 pools selected observations before computing distinct days.
The focused server/shared suites pass 221 tests, and the two real PostgreSQL
suites pass 43 tests. Mobile passes 1,983 tests; the web chart and chart wrapper
pass 37 tests, including accessible period totals. Full lint and root/server/web/
mobile typechecks pass. Independent contract and accessibility reviews found no
remaining issues.

Final local checkpoint: the full unit/mobile run passes 22,488 tests across
1,389 files, with 19 existing skipped tests, four workers and zero retries.
The repository spelling check passes with zero issues.

CI follow-through: remove the calendar helper's circular type dependency and
update ten Expo SDK packages to the current stable compatibility patches. The
exact import-boundary check, Expo dependency check and iOS Metro export pass.
The post-update full unit/mobile suite passes 22,510 tests across 1,389 files
with four workers and zero retries; lint, spelling and all typechecks pass.

### Task 5: Resolve feedback, validate the merge head and merge the PR

- [x] Preserve both main and branch documentation during conflict resolution.
- [x] Advance cache contracts beyond both merged branches and verify cache invalidation.
- [x] Limit unknown-outcome qualifiers to period totals and strengthen test assertions.
- [x] Reply with concrete fix details and resolve every actionable review thread.
- [ ] Commit and push the merged implementation; verify required CI on that exact head.
- [ ] Merge PR #3131 after its required checks pass and verify GitHub reports it merged.
