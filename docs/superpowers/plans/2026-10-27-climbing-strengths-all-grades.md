# Climbing Strengths Across Grades Implementation Plan

Work through each task in order: add the regression, run it, implement the change, run the listed checks, and review the result before continuing.

**Goal:** Apply the approved fixed radar, heatmap and monthly views on both clients.

**Architecture:** Compute grade-adjusted observed-versus-expected differences on the server. Use a fixed radar, grade/style heatmap and one monthly plot. Apply settings only through the existing upstream filter; store point selection separately from the displayed cohort.

**Tech Stack:** React, React Native, ECharts, react-native-svg, Vitest.

**Spec:** ../specs/2026-10-27-climbing-strengths-all-grades-design.md

## Revised scope (approved in conversation)

Keep Styles / Grades / Progress with one fixed visualization each. Styles is a server-computed grade-adjusted radar; Grades a heatmap; Progress a single combined monthly plot. No grade or format picker. Add `gradeAdjustedStrengths` to the response contract and test the server calculation, zero/unknown results, weighted grade mixtures and the five-known-result sample boundary.

## Global Constraints

- Wall angle / Hold type plus three fixed tabs; no client metric calculations or storage changes.
- Preserve zero, unknown and missing outcomes, climbing-context separation and source navigation. Settings remain exclusively in the page-wide filter.
- Continue in the existing isolated worktree and branch.

## Review Focus

- Initial loading versus cached refresh and errors.
- Unknown-only and missing-dimension contexts.
- Point selection after refreshed data or dimension changes.
- Multiple contexts/settings must keep details isolated.
- Sparse/limited observations must retain their chart semantics.

### Task 1: Replace strengths navigation on both clients

**Files:** packages/web/src/components/ClimbingStrengths{.tsx,.test.tsx}; packages/mobile/components/ClimbingStrengths{.tsx,.test.tsx}; obsolete ClimbingStrengthsViewPicker files.

**Interfaces:** Consume complete ClimbingStrengthsPanel and existing curves renderers. Point-selection callbacks retain row and grade, never filter chart data.

- [x] Write tests that select exact values at two grades using the default chart, open source details and preserve chart-wide values after selection.
- [x] Run the focused suites and observe failure before changing production code.
- [x] Simplify both components, preserve source details and state handling, delete obsolete picker code and tests.
- [x] Verify all Review Focus cases in focused tests and existing chart suites.

### Task 2: Update stories, route tests and docs; validate and push

**Files:** strengths stories, climbing route/strain tests, web/mobile README, shared strengths-view navigation definitions if unused.

**Interfaces:** Retain the existing chart renderer contract and server data.

- [x] Replace removed view-switching interactions with point selection and dimension changes.
- [x] Update docs with the approved default and keep third-party claims cited.
- [x] Run affected Vitest suites, package typechecks, Biome and diff checks.
- [x] Visually inspect web and mobile stories; review the completed diff.
- [x] Commit and push the branch.

## Working notes

- Design approved in conversation; execute inline in the existing workspace.
- Review checkpoint 1: default all-grade point selection passes on both platforms.
- Review checkpoint 2: stories, routes, typechecks and final diff pass.

- Checkpoint 1: all-grade chart and selection changes pass 145 focused tests; 229 related mobile accessibility tests pass; web/mobile typechecks pass. Reviewer accessibility findings were reproduced and fixed.
- Pending direction: user requested retained Styles/Grades/Progress tabs and a preview of one visualization per tab. The revised prototype is ready; product tab changes await that review.

- User approved the three-tab preview and then the grade-adjusted radar. Removed the earlier proposal to eliminate tabs.
- Server profile tests passed before UI wiring, including mixed difficulties and unknown outcomes. Review found and reproduced adjusted-radar exact-value column/limited-status issues; fixes pass.

- Final user correction: Setting belongs exclusively in the filter. Removed both setting headings and setting-split profiles; a mixed-setting regression failed before the aggregation change and passes afterward.
- Final review: no important remaining issues; six focused suites passed 91 tests. Full related and integration checks run again after this correction.

## Final verification and retrospective

849 related unit/mobile tests and 42 PostgreSQL integration tests passed. Web, mobile and server typechecks, changed-file Biome checks, Storybook coverage and review-scenario policies passed. Visual review covered the radar, Grades and Progress for hold types on both clients; wall-angle behavior is covered by the same components and tests.

The existing renderers were reusable. The main investigation was separating grade-adjusted scoring from raw pooled success, and removing a duplicate setting split. The [score tests](../../../packages/server/src/services/climbing-strength-profile.test.ts) cover mixed difficulties, unknown results and sample boundaries; the [aggregation tests](../../../packages/server/src/services/climbing-strengths.test.ts) protect the single selected-setting cohort. Suggested guidance: a filter dimension should have one control, with no second chart split unless explicitly requested. For similar work, use the chart stories and integration-tests-ready skill.
