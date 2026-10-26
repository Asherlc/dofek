# Climbing Visualization Options Implementation Plan

> Execute each task with its test-first cycle and independent review checkpoint. Track validation and review results in the [pull request](https://github.com/Asherlc/dofek/pull/3089).

**Goal:** Offer all six approved climbing visualizations plus the current grade profile through a View picker on web and mobile.

**Architecture:** Extend the existing server-computed strengths response with monthly cells. Keep selection in the existing platform components and render alternatives with their existing chart libraries. Share option names and types in the training package.

**Tech Stack:** TypeScript, Zod, tRPC, Vitest/PostgreSQL, React/ECharts, React Native/react-native-svg.

**Spec:** [Climbing visualization options](../specs/2026-10-26-climbing-visualization-options-design.md)

## Global Constraints

- No branch switching, new dependencies, persistence, schema, provider changes, or new HTTP servers. Every new commit must be pushed automatically.
- All metric values remain server-computed; clients may format and position supplied values.
- Shared picker values/labels: profile / Grade profile; gaps / Style gaps; curves / Success curves; exposure / Exposure map; pyramids / Grade pyramids; progress / Progress; radar / Radar profile.
- Default profile preserves current presentation. Switching views preserves valid context, setting, grade, row and source-detail selection.
- Missing remains null; zero remains zero. Keep sample counts and limited-data qualifiers. Radar requires at least three usable groups, otherwise explain its unavailable polygon.
- Required panel.progress: Array<{startDate:string;endDate:string;rows:Array<{key:string;cells:Array<{grade:string;sends:number;climbs:number;successRate:number|null;sampleStatus:'no_data'|'limited'|'available'}>}>}>.
- Progress dates are clipped calendar months in the same required analysis window as the repository query. Monthly outcomes use original observations after whole-window identity/context/grade/trait resolution.
- Progress selection refers to the overall style/grade detail and labels that scope. All rows/grades remain available in exact-data disclosures.
- Use ECharts through DofekChart on web and react-native-svg/AccessibleChart on mobile; no alternate chart dependency.
- Run tests before implementation. Do not commit output/ mockups or diagnostic artifacts.

## Review Focus

- A climb failed in one month and sent later must retain the earlier monthly failure while counting once overall.
- Context or grade changes during a background refresh must not retain stale, invalid detail selections.
- Unknown-only and sparse contexts must retain navigation and zero/null distinctions in every view.
- Numeric-angle rows, long labels, few grades/months, and dense series must remain usable and accessible.
- Different cache versions and date anchors must not reuse responses with the old shape or a different monthly window.

---

### Task 1: Monthly response and shared view contract

**Files:**
- Modify `packages/training/src/climbing-strengths.ts`.
- Create `packages/training/src/climbing-strengths-views.ts`.
- Modify `packages/server/src/services/climbing-strengths.ts` and its test.
- Modify `packages/server/src/routers/climbing.ts` and its test.
- Update strengths repository integration regression and server/training READMEs.

**Interfaces:**
- Export `CLIMBING_STRENGTHS_VIEWS` as readonly `{value,label}` entries with the exact names above, and `ClimbingStrengthsView` as their value union.
- `buildClimbingStrengths(observations, window: {startDate:string;endDate:string}): ClimbingStrengths` supplies required panel.progress.
- Preserve repository API; pass an explicit effective endDate through the existing optional anchor path. Use existing date/format helpers and the user's timezone.

- [ ] Write failing tests for independent monthly outcomes, cross-source missing-grade context, excluded conflicting grades, clipped empty months, actual recorded zero and empty response.
- [ ] Verify RED, then implement one canonical whole-window identity resolution with monthly outcome projection; avoid recursive independent month analyses.
- [ ] Update router date-window forwarding and cache version; test explicit and omitted timezone-aware anchors.
- [ ] Run focused unit suites, server/training typechecks and real PostgreSQL strengths/canonical regression suites. Record command outputs.
- [ ] Supply a task report and scoped diff for independent spec/quality review; resolve findings.

### Task 2: Web visualization choices

**Files:**
- Modify `packages/web/src/components/ClimbingStrengths.tsx`, tests, stories and fixture.
- Modify `packages/web/src/routes/training/climbing.tsx` and its test to include the existing local-date anchor in the strengths query key.
- Create `ClimbingStrengthsChart.tsx`, chart options helper, their focused tests and chart story if independently reusable.
- Update `packages/web/README.md`.

**Interfaces:**
- Consume shared `ClimbingStrengthsView` metadata and required panel.progress from Task 1.
- Renderer consumes panel, view, selected grade/style and an `onSelectCell(rowKey,grade)` callback; exact prop spelling is the implementer's call within this platform.
- Preserve existing component query inputs; changing view is presentation-only and causes no new query.

- [ ] Write failing tests for all seven picker options and retained grade/context/setting/detail across changes and fresh response objects.
- [ ] Implement View/Grade controls and ECharts alternatives using DofekChart and existing theme, event and accessibility conventions.
- [ ] Test supplied metric values, null gaps/recorded zero, limited samples, click selection, progress full-period detail scope, sparse radar, dense/long labels and tooltip escaping.
- [ ] Test date-anchor changes in the strengths query input using the existing useTodayQueryDate hook; other climbing queries keep their current inputs.
- [ ] Add one coherent Storybook scenario per view plus sparse/unknown-only coverage; run focused web tests, typecheck and Biome.
- [ ] Supply task report and scoped diff for independent spec/quality review; resolve findings.

### Task 3: Mobile visualization choices

**Files:**
- Modify `packages/mobile/components/ClimbingStrengths.tsx`, tests, stories and fixture.
- Create `ClimbingStrengthsChart.tsx` and focused tests/story; extract native view picker if needed for focused responsibility.
- Update `packages/mobile/README.md`.

**Interfaces:**
- Consume the same shared view metadata, panel.progress and selection behavior as Task 2.
- Use a compact native picker following the existing modal radio pattern, measured SVG width and AccessibleChart.
- All files remain outside mobile/app unless they are real routes.

- [ ] Write failing picker and retained-selection tests before implementation.
- [ ] Implement all six SVG alternatives while preserving existing profile, details, error/loading/empty and coverage behavior.
- [ ] Test exact supplied numbers, null versus zero, limited samples, no-data months, single/dense axes, radar minimum groups and accessible selection without tiny mark targets.
- [ ] Add parity stories; run focused mobile tests, typecheck and Biome.
- [ ] Supply task report and scoped diff for independent spec/quality review; resolve findings.

### Task 4: Integrate, verify, and update PR

- [ ] Independently review each task's concrete diff and test report, followed by one whole-change review.
- [ ] Browser-check all views in light/dark desktop and narrow mobile Storybook, including context/grade changes and preserved detail. Reuse existing tunneled Storybook servers where alive; if starting a server, start and retain its quick tunnel.
- [ ] Run full lint, root/server/web/mobile/training typechecks, spelling, full unit/mobile tests, relevant real PostgreSQL regressions and production web build. Run bounded changed-line mutation checks for new branches.
- [ ] Commit the integrated contract/client change atomically after cross-platform checks, push immediately, and update existing PR #3089. The user subsequently authorized merging; merge manually after all required checks pass. Do not enable automerge.
- [ ] Monitor required CI and actionable review feedback to completion, fix valid findings, and report outcome plus concise retrospective.
