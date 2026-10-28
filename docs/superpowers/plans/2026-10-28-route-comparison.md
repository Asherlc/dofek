# Route comparison implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute the tasks with explicit review checkpoints.

**Goal:** Replace the crowded name-grouped chart with a readable comparison of attempts on one GPS-matched route.

**Architecture:** Reuse [the existing route matcher](../../../packages/server/src/repositories/route-equivalence.ts) over the current serving projections. The server returns identified, dated attempts with nullable pace; web and mobile render the same [shared contract](../../../packages/training/src/route-comparison.ts).

**Tech Stack:** TypeScript, tRPC, ClickHouse, React/ECharts, React Native/SVG, Vitest.

**Spec:** The user's chart feedback and request for a PR, following the recommended GPS-based comparison. Show one route's pace observations at a time, a route selector, visible date and pace axes, and exact attempt values with activity navigation. Missing pace is unavailable. Do not infer improvement or comparable conditions from route identity.

## Global constraints

- Keep the existing branch and workspace; no branch switching.
- Reuse `groupEquivalentRoutes`; no new matching algorithm, dependency, or analytics model.
- Compute metric values and attempt counts on the server.
- Preserve loading, empty, error, and cached-data refresh states.
- Use the unit contexts for formatting and conversion.
- Add reusable component stories and interaction tests on both clients.
- Push every new commit and open a PR; do not merge it.

## Review focus

- Same activity names on unrelated GPS tracks must not form one route.
- Same GPS route with different names must still match; walking/running contexts remain separate.
- Missing/nonpositive distance or pace must not appear as a fastest observation.
- Same-day attempts retain activity identity and their actual timestamps.
- Many routes, long names, refresh/removal of the selected route, and narrow screens remain usable.

## Task 1: Server route grouping and response

**Files:** `packages/training/src/route-comparison.ts`, `packages/server/src/repositories/hiking-repository.ts`, `packages/server/src/routers/hiking.ts`, their existing tests, and a focused real-ClickHouse integration test.

**Interface:** `hiking.activityComparison` returns `RouteComparison[]` from the shared schema. Each group has `routeId`, `activityName`, `activityType`, `attemptCount`, and `instances`; each instance has identity, timestamp, local date, distance, duration, nullable pace, heart rate, and elevation.

- [x] Write and run failing unit and database regressions for geometry grouping, ownership, date ranges, deleted data, and missing pace.
- [x] Join current hiking, canonical activity, and route-identity projections; reuse bounded complete-link GPS grouping.
- [x] Return chronologically ordered identified attempts; expose unavailable pace as null and explicit actionable errors when the existing matcher bounds are exceeded.
- [x] Validate output with the shared Zod schema and version the response cache.
- [x] Run focused tests and review the server diff.

## Task 2: Web comparison

**Files:** `packages/web/src/components/ActivityComparisonChart.tsx`, its test/story, and relevant page tests.

**Consumes:** `RouteComparison[]`.

- [x] Write failing tests for route selection, timestamped dots, unavailable pace, unit labels, and selection reconciliation after refresh.
- [x] Replace overlaid series/legend with an accessible route select, one scatter series, visible dates, nonzero-scaled pace axis, and an exact-values attempts table with activity links.
- [x] Add realistic crowded, same-day, unavailable-pace, empty/loading, imperial, and narrow stories.
- [x] Run component tests, typecheck, and browser visual review.

## Task 3: Mobile parity

**Files:** New mobile comparison component/card/test/stories, `packages/mobile/app/(tabs)/strain.tsx`, and its test/story fixtures.

**Consumes:** The same shared schema and endpoint as web.

- [x] Write failing tests for route selection, unavailable pace, exact values, activity navigation, and query states.
- [x] Add the focused SVG comparison to Training with accessible controls and exact attempt values.
- [x] Preserve cached data on refresh and invalidate this query with the screen's refresh action.
- [x] Run mobile tests and typecheck, then review the mobile diff.

## Task 4: Verification and PR

- [ ] Run relevant real-engine integration tests, repository lint/typechecks and unit/mobile suites.
- [ ] Obtain an independent whole-change review and resolve material findings.
- [ ] Update relevant shared documentation with source links and record the review/test evidence.
- [ ] Commit, push, open the PR with concrete validation, and monitor checks and actionable review feedback.

## Working notes

- User's `pr` is treated as authorization to implement the recommended scope and open the PR.
- Client work may proceed in parallel against the shared contract because the file ownership is disjoint.
- Review checkpoints: focused per-task test/diff review; independent whole-change review before readiness.

## Review outcomes

Independent review identified the cycling-only projection and route-selection resets. The existing projection now includes walking, hiking, and trail running; full and incremental model tests plus a model-to-serving regression execute against ClickHouse. The shared selection resolver retains current groups across anchor changes. All findings were addressed and independently re-reviewed. Browser review covered crowded and narrow web histories and the mobile SVG. Pace units moved above the web plot after narrow-view inspection exposed an axis-label collision.
