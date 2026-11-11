# Climbing HR Overlay Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Overlay precisely timed climbs on web/mobile heart-rate charts.
**Architecture:** Server projects retained source timestamps onto climbing-log
details. Both existing chart renderers consume a shared annotation contract.
**Tech Stack:** TypeScript, Zod, ECharts, react-native-svg, Vitest.
**Spec:** ../specs/2026-10-29-climbing-hr-overlay-design.md

## Global Constraints

Both platforms; server-owned timing projection; no new storage/dependencies;
date-only records excluded; no branch switching.

## Review Focus

- Invalid/date-only/local timestamps must not become false instants.
- Consolidation must preserve timing from a secondary source.
- Session summaries must not place every climb at the session start.
- Out-of-range and partially overlapping annotations must respect plot bounds.
- Repeated climb names must retain distinct selectable occurrences.

### Task 1: Server timing projection

Files: shared `packages/training/src/climbing-chart.ts`; server
`services/climbing-chart-annotations.ts`, `contracts/climbing-log-contracts.ts`,
`repositories/climbing-activity-log-entry-repository.ts` and colocated tests.
Produces: `ClimbingChartAnnotation` with id, label, startedAt, endedAt;
optional `chartAnnotations` array on climbing-log details.

- [x] Write/run failing projection and consolidation tests.
- [x] Implement source-aware KAYA projection and preserve annotations.
- [x] Run focused unit tests and typechecking.

### Task 2: Web and mobile rendering

Files: both `ActivityDetailCharts` implementations/tests/stories, web
`ActivityDetailPage.tsx`, mobile `app/activity/[id].tsx`.
Consumes: `ClimbingChartAnnotation[]` from climbing-log details.

- [x] Write/run failing marker, range, boundary and interaction tests.
- [x] Wire activity screens and implement overlays in existing renderers.
- [x] Add representative stories and visually inspect chart output.
- [x] Run relevant tests, lint/typecheck, review diff, commit and push.

## Working notes

User approved the proposed overlay before this plan. Execute in the existing
isolated workspace; approval persists across workflow steps.

Validation: 22,695 tests pass in the full unit/mobile suite (19 existing
skips). Root, server, web and mobile TypeScript checks and `lint:sandbox` pass.
Firefox verified web climb tooltips and mobile marker selection. Independent
review confirmed nearest-marker selection handles nearby climbs and enclosing
bands. Current retained KAYA timing supplies instants, not end boundaries.
