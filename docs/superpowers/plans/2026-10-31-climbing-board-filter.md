# Climbing Board Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Filter existing climbing views by recorded board context on web and iOS.

**Architecture:** Extend the shared filter contract and existing server SQL projection.
Both clients render the same board choices through their current filter controls.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, React/React Native, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-climbing-board-filter.md`.

## Global Constraints

- Keep the combined default and existing bouldering discipline/kind.
- Use recorded board metadata; missing metadata is not proof of non-board climbing.
- No schema migration, new dependencies, environment variables, or client metric computation.
- Add optional `board` choices `recorded` and `not_recorded`, normalized to arrays.
- Both choices/omission select all; an empty array selects none.
- UI copy: Board; Board climbs; No board recorded; All. Show the group before More filters.
- No branch switching. Root owns commits, automatic pushes, PR updates and documentation.

## Review Focus

- Mixed-source imports must classify rows from facts, not the provider ID.
- Empty and combined selections must not silently return the wrong totals.
- Board and setting/type restrictions intersect without changing other selections.
- Both clients display active restrictions and preserve existing accessibility behavior.
- Shared projection consumers must receive the filter before server aggregation.

### Task 1: Shared contract and executable server filtering

**Files:** `packages/training/src/climbing-filters.ts`, its colocated test,
`packages/server/src/repositories/climbing-rock-observations.ts`, existing
climbing repository/router integration tests as appropriate.

**Interfaces:** `ClimbingFilters.board?: ('recorded' | 'not_recorded')[]`.
Add `climbingFilterOptions.board` labels specified above and `climbingFilterLabels.board`.
Extend `climbingFilterSelection`/`toggleClimbingFilter` to accept `board` alongside
advanced keys; keep it out of `climbingAdvancedFilterKeys` because it is a primary group.
Append restricted board labels to `climbingFilterSummary`; omit suffix for all and
use `No board selection` for empty choices. Preserve existing summary output by default.

- [x] Write failing normalization, toggle/reset/empty, and summary tests.
- [x] Write failing real-Postgres tests for board presence/missing, mixed providers,
  omitted/both/empty choices, setting intersections and representative aggregate counts.
- [x] Implement the contract/helpers and metadata predicate in the shared projection.
- [x] Run targeted unit/integration tests and server/shared types; report evidence for review.

### Task 2: Web and mobile filter controls

**Files:** `packages/web/src/components/ClimbingFilters.tsx`, its tests/stories;
`packages/mobile/components/ClimbingFilters.tsx`, its tests/stories.

**Interfaces:** Consume Task 1's exact field, labels and shared toggle/selection helpers.
Board is a primary checkbox group after Setting, with both choices selected initially.
Restricted choices appear through the shared summary, not duplicate chips.

- [x] Write failing web/mobile interaction tests for selection, independent settings,
  all/none, reset and accessible checkbox state.
- [x] Render Board on both platforms using the existing control styles and shared helpers.
- [x] Add paired board-filtered stories and run focused interaction tests and typechecks.
- [x] Report changed files, RED/GREEN evidence and story IDs for independent review.

### Task 3: Review and delivery

**Files:** Active climbing/provider docs, task ledger, PR description.

- [x] Review each task and the integrated diff; fix confirmed issues with regression coverage.
- [x] Browser-check the specific board-filter story at desktop and phone width.
- [x] Run required lint, relevant unit/mobile/integration tests and all four typechecks.
- [x] Commit and automatically push on `lazy-emu`; update PR #3181 and report CI honestly.

Current PR CI failures (Squawk constraint replacement and Expo patch mismatch) are
investigated independently. Do not weaken checks or add exclusions without the
explicit approval required by repository guidance.
