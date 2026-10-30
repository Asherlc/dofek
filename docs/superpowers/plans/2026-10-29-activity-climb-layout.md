# Activity climbing layout implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task.

**Goal:** Deliver the approved grouped list and one shared activity map on web/iOS.
**Architecture:** Reuse domain area/coordinate grouping, existing cards and MapLibre renderers. Panel owns selection; source details remain a separate explicit action.
**Tech Stack:** React, React Native, MapLibre, Vitest, Storybook.
**Spec:** docs/superpowers/specs/2026-10-29-activity-climb-layout-design.md

## Global Constraints

- Stay on feat/activity-climb-map-layout; no engine migration or new dependencies.
- Server metrics remain unchanged; preserve provenance and interactions.
- Push commits automatically after required checks. Do not merge.

## Review Focus

- Duplicate names/coordinates must preserve occurrence identity.
- Area approximations must never imply exact climb GPS.
- Selection and hover must not reset camera or recreate map.
- Missing GPS must retain accessible list/detail controls.
- Narrow screens and large text must retain all controls.

### Task 1: Web and mobile shared selection layout

Files: ActivityClimbingPanel.tsx/test/stories on each platform; existing ActivityRouteMap/RouteMap; both activity detail screens.
Interfaces: panel consumes entries, locations, route points and onOpenEntry; maps consume selectedEntryId and web highlightedEntryId.
- [x] Write failing interaction tests for row selection, hover/focus, marker-to-row selection, coincident points and missing GPS.
- [x] Run tests and observe missing behavior.
- [x] Implement panel and map inputs; integrate both activity screens.
- [x] Run focused tests, then relevant suites.

### Task 2: Preview, verification, review and ship

- [x] Add full-layout web/mobile stories, empty/narrow variants and rendered interaction checks.
- [x] Start tunneled Storybook and verify real map hover, focus, click, overlap selection and narrow layout.
- [ ] Run lint, relevant tests, all required typechecks, build and size checks.
- [x] Obtain fresh code review; fix important findings with regression tests.
- [ ] Commit and push; open a PR with direct preview and honest validation notes.
