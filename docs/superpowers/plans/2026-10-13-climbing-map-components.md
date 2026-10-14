# Climbing Map Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement activity-detail climb dots, tick point maps, and responsive tick grids, then validate them with Storybook fixtures on web and mobile.

**Architecture:** Components consume explicit source-location inputs alongside existing climbing entries. Reuse the current Leaflet and native map components for route and dot rendering. The user explicitly scoped this iteration to components and Storybook; canonical storage, provider ingestion, coordinate resolution, and live API wiring remain a separate implementation.

**Tech Stack:** Existing React, TypeScript, Leaflet, React Native Maps, Vitest, and Storybook dependencies.

**Spec:** [Activity-detail maps and grid](../specs/2026-10-13-climbing-log-model-summitpost-design.md#activity-detail-climb-maps-and-grid), with the component-only scope confirmed by the user on 2026-10-13.

## Global Constraints

- Work in the existing `feat/climbs-map-gps-dots` worktree; do not switch branches.
- Implement equivalent components and stories on web and mobile.
- No provider, database, server API, or dependency changes in this iteration.
- Preserve source order, repeated occurrences, source links, and independent Attach pending/error states.
- A containing place is labeled **Area location**; activity sensor GPS never supplies a missing tick location.
- Source dots are independent of the sensor polyline; one-point previews have one source dot and no Start/Finish pins.
- Keep sensor GPS export and chart-scrubbing eligibility unchanged.
- Follow repository TDD and component-story requirements. Read package READMEs and local instructions; prefix shell commands with `rtk`.
- Root coordinates commits after required checks and pushes every commit automatically.
- Every development server has a persistent quick tunnel; user-facing preview links use its emitted `https://…trycloudflare.com` URL.

## Review Focus

- Points-only maps display a finite local viewport without implying a recorded GPS track.
- Area points retain their owning name/provider and cannot appear as exact climb points.
- Repeated ticks at identical coordinates remain separate cards and named map inputs.
- Long names and source links stay readable on narrow cards without obscuring Attach controls.
- Source text in map tooltips is rendered as text, including hostile HTML characters.

### Task 1: Shared location inputs and web components

**Files:**
- Create `packages/training/src/climbing-map.ts` with type-only location/marker contracts.
- Create `packages/web/src/components/ActivityRouteMap.tsx`, its colocated tests and stories.
- Modify `packages/web/src/pages/ActivityDetailPage.tsx` to consume the extracted route component, preserving existing query and sensor behavior.
- Modify `packages/web/src/pages/activity-detail/components/ClimbingEntryBreakdown.tsx` and `UnattachedClimbingEntries.tsx`, plus their existing tests and stories.
- Create a focused web tick-card component only if shared attached/suggestion presentation needs it, with colocated tests/stories.

**Interfaces:**
- Shared `GpsCoordinates = { latitude: number; longitude: number }`.
- Shared `ClimbingMapLocation = { coordinates: GpsCoordinates; scope: "climb" | "area"; objectId: string; providerId: string; name: string | null }`.
- Shared `ClimbingMapMarker = { entryId: string; entryNumber?: number; label: string; location: ClimbingMapLocation }`. The presentation number follows the full card order, including cards without GPS.
- `ActivityRouteMap` consumes existing `points: { lat: number; lng: number }[]`, optional `climbMarkers: readonly ClimbingMapMarker[]`, and the existing hover-callback ref. Support concrete detail and compact-card presentations.
- Entry grid components accept optional `locations: Readonly<Record<string, ClimbingMapLocation>>`, keyed by entry ID. Existing live callers continue to render their supplied entries; stories supply GPS locations explicitly.

- [x] Write failing behavior tests for source markers without a route, combined route/dots, single-point previews, area labels, repeated IDs at one point, safe tooltip text, independent Attach states, and preserved links.
- [x] Run the focused web tests and verify failures describe the missing behavior.
- [x] Implement shared input types, extract the existing Leaflet map, and render the attached/suggested tick grids. Preserve the route, start/end, attribution, hover cleanup, and sensor-only page gating. Report unexpected map initialization failures to Sentry and keep the cards usable on map errors.
- [x] Add default, loading, empty, error, route-plus-dots, points-only, exact-climb, area, mixed-GPS, long-name, repeated-point, and narrow/wide Storybook cases as applicable.
- [x] Run focused web tests and web/training typechecks; obtain independent spec and quality review before proceeding.

Run: `pnpm exec vitest run --project unit packages/web/src/components/ActivityRouteMap.test.tsx packages/web/src/pages/activity-detail/components/ClimbingEntryBreakdown.test.tsx packages/web/src/pages/activity-detail/components/UnattachedClimbingEntries.test.tsx packages/web/src/pages/ActivityDetailPage.test.tsx`.
Expected: all selected tests pass.

### Task 2: Mobile map and tick-grid equivalents

**Files:**
- Modify `packages/mobile/components/RouteMap.tsx`, its colocated tests and stories.
- Create focused `packages/mobile/components/ClimbingEntryCard.tsx` and `ClimbingEntryGrid.tsx`, with colocated tests and stories.
- Modify `packages/mobile/app/activity/[id].tsx` to consume the card/grid presentation while preserving its current data/query behavior.
- Modify `packages/mobile/app-tests/activity/[id].test.tsx` for the changed presentation and existing Attach interactions.
- Update `packages/mobile/.storybook/mocks/react-native-maps.tsx` if needed so coordinates and distinct markers can be visually inspected; test any new mock runtime behavior next to that file.

**Interfaces:**
- Consume the shared location and marker inputs from Task 1.
- `RouteMap` retains its `points` and `hoveredPosition` inputs, adds optional `climbMarkers`, and supports a compact single-point preview.
- Tick card/grid components consume the existing attached/suggestion entry contracts, optional location inputs, and explicit attachment state/action props. Do not fabricate API fields.

- [x] Write and run failing tests for points-only native maps, separate source markers, area provenance, one-point cards, stable entry order, long-name grids, and independent attachment errors/pending states.
- [x] Implement native source dots and card grids. Preserve the measured-width map mounting gate, existing sensor route/hover behavior, and sensor-only GPX/TCX eligibility.
- [x] Add paired mobile Storybook states matching the web cases. The web map adapter must represent supplied coordinates so separate dots can be inspected.
- [x] Run focused mobile tests and mobile typecheck; obtain independent spec and quality review.

Run: `pnpm exec vitest run --project mobile packages/mobile/components/RouteMap.test.tsx packages/mobile/components/ClimbingEntryCard.test.tsx packages/mobile/components/ClimbingEntryGrid.test.tsx 'packages/mobile/app-tests/activity/[id].test.tsx'`.
Expected: all selected tests pass.

### Task 3: Storybook validation and delivery

**Files:**
- Update `packages/web/README.md` and `packages/mobile/README.md` to identify the component stories and the explicit location-input boundary, citing source components and the design.
- Record task reviews and visual findings in this plan's `.superpowers/sdd/` progress ledger.

- [x] Start web and mobile Storybook development servers with a quick tunnel for each server's lifetime.
- [x] Use browser tooling to inspect route-plus-dots, points-only, mixed-GPS grids, long names, Attach pending/error, and narrow/wide layouts. Inspect accessible labels and console errors; fix observed problems with focused regression tests.
- [x] Run `pnpm lint`, root and all package typechecks, relevant unit/mobile suites, and both Storybook production builds. Expected: every command exits successfully.
- [x] Obtain a fresh whole-change review against this plan and the user-approved component-only scope.
- [x] Commit and push the implementation, verify clean Git status, and deliver the two tunnel preview links with an explicit statement that live GPS wiring remains separate.

### Task 4: Requested climbing copy refinement

The user requested removal of "attempt count not recorded" during delivery.
Update the [shared climbing result formatter](../../../packages/format/src/format.ts)
so web and mobile retain recorded results and known counts without that missing-count
message. Preserve existing source-context distinctions and avoid inventing counts.

- [x] Update existing formatter assertions, verify RED, implement concise labels, and update affected web/mobile assertions.
- [x] Run covering tests and static checks; review the change and verify the visible Storybook copy on both platforms.

Verified on 2026-10-13: 17,483 unit tests and 1,458 mobile tests passed, along
with lint, root/all-package typechecks, web production build, and both
Storybook production builds. Browser checks covered narrow/wide grids,
source-only and combined maps, source provenance, production occurrence
selection/card highlighting, keyboard access, lazy previews, Attach states,
and the requested copy. Native device rendering and VoiceOver were not audited.
