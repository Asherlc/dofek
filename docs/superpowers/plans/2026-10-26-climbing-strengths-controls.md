# Climbing Strengths Controls Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Implement combined All grades and concise, functional controls on web and mobile.

**Architecture:** Keep per-grade profiles intact and add a server-computed
`allGrades` profile containing a single combined result per style/month.
Clients select the projection without calculating metrics. The existing
canonical repository enforces ownership, access windows and end-date bounds.

**Tech Stack:** TypeScript, Zod, Drizzle, React, React Native, ECharts, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-climbing-strengths-controls-design.md`

## Global Constraints

- Stay on the current branch; push new commits.
- Server computes all metrics; no new dependencies or storage.
- Missing aid use means free; explicit aid remains separate.
- Implement both clients; retain the approved copy removals.

## Review Focus

- Repeated/cross-provider climbs count once in All grades.
- Pooled rates use counts, not averages of per-grade percentages.
- All time retains access restrictions and excludes future observations.
- Grade selection persists when switching between views.
- Null aid and false aid merge; explicit aid and distinct scopes stay separate.

### Task 1: Server projections and historical range

**Files:** training climbing-strengths contract; server strengths service,
repository, canonical CTE and router; their colocated tests.

**Interfaces:** Add `ClimbingStrengthsPanel.allGrades` with the same
`grades`, `rows`, `progress` structure as the per-grade profile. Export
`ALL_CLIMBING_GRADES` and `climbingStrengthsGradePanel(panel, grade)` as shared
presentation helpers. Accept `days: null` on the strengths endpoint.

- [ ] Add failing service tests for pooled counts, deduplication, monthly outcomes and empty data.
- [ ] Add failing router and executable repository tests for null days, end dates, aid normalization and access restrictions.
- [ ] Run the tests and confirm the intended failures.
- [ ] Implement projections, concise context labels and bounded historical queries; update the output cache version.
- [ ] Run service/router unit tests and the strengths repository integration suite. Expected: all pass.
- [ ] Commit and push.

### Task 2: Clients and Storybook

**Files:** web/mobile ClimbingStrengths components and fixtures, their tests,
web climbing route and chart options; strengths stories.

**Interfaces:** Consume Task 1's computed profile. All grades is the default
for views with a grade selector; the grade profile table remains per-grade.

- [ ] Add failing web/mobile interaction tests for All grades, specific grades, view switching and concise context choices.
- [ ] Update the real clients, historical request input and baseline wording.
- [ ] Replace illustrative-only aggregate stories with stories using the production component and server-shaped fixtures.
- [ ] Run affected tests, both client typechecks, server typecheck, changed-file lint and Storybook interaction/visual checks. Expected: all pass.
- [ ] Commit and push.
- [ ] Run a fresh final review of the complete implementation and address material findings.
