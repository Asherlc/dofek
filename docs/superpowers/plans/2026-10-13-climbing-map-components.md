# Climbing Map Components Implementation Plan

<!-- cspell:words activityroutemap routemap -->

**Goal:** Implement activity-detail climb dots, point-map previews, and responsive climbing-log grids, then validate them with Storybook fixtures on web and mobile.

**Architecture:** Components consume explicit source-location inputs alongside the canonical [climbing-log detail contract](../../../packages/server/src/contracts/climbing-log-contracts.ts). Reuse the [web route map](../../../packages/web/src/components/ActivityRouteMap.tsx) and [native route map](../../../packages/mobile/components/RouteMap.tsx) for route and dot rendering. This iteration covers components and Storybook; coordinate resolution and live GPS API wiring remain separate.

**Tech Stack:** Existing React, TypeScript, Leaflet, React Native Maps, Vitest, and Storybook dependencies declared in the [web](../../../packages/web/package.json), [mobile](../../../packages/mobile/package.json), and [root](../../../package.json) manifests.

**Spec:** [Activity-detail maps and grid](../specs/2026-10-13-climbing-log-model-summitpost-design.md#activity-detail-climb-maps-and-grid), with the component-only scope confirmed by the user on 2026-10-13.

This completed plan was updated during integration with the [canonical climbing model cutover](../../climbing-log-model-cutover.md). Paths and verification commands below refer to the resulting components. Run commands from the repository root after following the [development setup](../../../README.md#quick-start) and [testing guide](../../testing.md).

## Global Constraints

- Implement equivalent components and stories on web and mobile.
- Keep this change within component presentation and Storybook fixtures; use the canonical model already supplied by the base branch. Provider ingestion, storage, server APIs, and dependencies are outside this component work.
- Preserve source order, repeated occurrences, source links, and independent Attach pending/error states.
- A containing place is labeled **Area location**; activity sensor GPS never supplies a missing tick location.
- Source dots are independent of the sensor polyline; one-point previews have one source dot and no Start/Finish pins.
- Preserve lifecycle queries, recorded-route loading/error states, sensor GPS export, and chart-scrubbing eligibility in the existing [web page](../../../packages/web/src/pages/ActivityDetailPage.tsx) and [mobile screen](../../../packages/mobile/app/activity/[id].tsx).
- Write failing behavior tests before implementation and keep component stories beside their source files, following the [testing guide](../../testing.md).

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
- Create `packages/web/src/pages/activity-detail/components/ClimbingLogEntryCard.tsx`, with colocated tests and stories.
- Modify `packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.tsx` and `UnattachedClimbingLogEntries.tsx`, plus their colocated tests and stories.

The [card](../../../packages/web/src/pages/activity-detail/components/ClimbingLogEntryCard.tsx) preserves canonical source links, scoped whole-climb/pitch summaries, and the existing details disclosure. The [breakdown](../../../packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.tsx) renders the grid; the [unattached wrapper](../../../packages/web/src/pages/activity-detail/components/UnattachedClimbingLogEntries.tsx) supplies attachment state and actions.

**Interfaces:**

- Import the canonical [`GpsCoordinates`](../../../packages/training/src/gps-coordinates.ts) type rather than declaring another coordinate type.
- Shared `ClimbingMapLocation = { coordinates: GpsCoordinates; scope: "climb" | "area"; objectId: string; providerId: string; name: string | null }`.
- Shared `ClimbingMapMarker = { entryId: string; entryNumber?: number; label: string; location: ClimbingMapLocation }`. The presentation number follows the full card order, including cards without GPS.
- [`ActivityRouteMap`](../../../packages/web/src/components/ActivityRouteMap.tsx) consumes existing `points: { lat: number; lng: number }[]`, optional `climbMarkers: readonly ClimbingMapMarker[]`, the existing hover-callback ref, and optional `onSelectEntry`. It supports detail and compact-card presentations.
- Entry grid components consume `ClimbingLogEntryDetail` and accept optional `locations: Readonly<Record<string, ClimbingMapLocation>>`, keyed by entry ID, plus `selectedEntryId` for occurrence highlighting. Existing live callers render their supplied logs; stories supply GPS locations explicitly. See the [shared map contracts](../../../packages/training/src/climbing-map.ts).

- [x] Write failing behavior tests for source markers without a route, combined route/dots, single-point previews, area labels, repeated IDs at one point, safe tooltip text, independent Attach states, and preserved links.
- [x] Run the focused web tests and verify failures describe the missing behavior.
- [x] Implement shared input types, extract the existing Leaflet map, and render the attached/suggested tick grids. Preserve the route, start/end, attribution, hover cleanup, and sensor-only page gating. Report unexpected map initialization failures to Sentry and keep the cards usable on map errors.
- [x] Add default, loading, empty, error, route-plus-dots, points-only, exact-climb, area, mixed-GPS, long-name, repeated-point, and narrow/wide Storybook cases as applicable.
- [x] Run focused web tests and web/training typechecks; review behavior against the specification.

Run: `pnpm exec vitest run --project unit packages/web/src/components/ActivityRouteMap.test.tsx packages/web/src/pages/activity-detail/components/ClimbingLogEntryCard.test.tsx packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.test.tsx packages/web/src/pages/activity-detail/components/UnattachedClimbingLogEntries.test.tsx packages/web/src/pages/ActivityDetailPage.test.tsx`.
Expected: all selected tests pass.

### Task 2: Mobile map and tick-grid equivalents

**Files:**

- Modify `packages/mobile/components/RouteMap.tsx`, its colocated tests and stories.
- Create `packages/mobile/components/ClimbingLogEntryCard.tsx`, with colocated tests and stories.
- Modify `packages/mobile/components/ClimbingLogEntryBreakdown.tsx` to render the grid and `UnattachedClimbingLogEntries.tsx` to supply attachment state and actions, with colocated tests and stories.
- Update `packages/mobile/.storybook/mocks/react-native-maps.tsx` if needed so coordinates and distinct markers can be visually inspected; test any new mock runtime behavior next to that file.

The canonical [activity screen](../../../packages/mobile/app/activity/[id].tsx) already consumes the [breakdown](../../../packages/mobile/components/ClimbingLogEntryBreakdown.tsx) and [unattached wrapper](../../../packages/mobile/components/UnattachedClimbingLogEntries.tsx). Integration updates those shared presentation components; the screen remains identical to the base branch. Its [route test](../../../packages/mobile/app-tests/activity/[id].test.tsx) now identifies Attach controls by their entry-specific accessible names. Lifecycle, query, and sensor behavior remain unchanged.

**Interfaces:**

- Consume the shared location and marker inputs from Task 1.
- [`RouteMap`](../../../packages/mobile/components/RouteMap.tsx) retains its `points` and `hoveredPosition` inputs, adds optional `climbMarkers` and `onSelectEntry`, and supports a compact single-point preview.
- The [card](../../../packages/mobile/components/ClimbingLogEntryCard.tsx) and grid consume `ClimbingLogEntryDetail`, optional location inputs, selected entry identity, and explicit attachment state/action props. Preserve canonical scoped results, source links, and the existing details disclosure.

- [x] Write and run failing tests for points-only native maps, separate source markers, area provenance, one-point cards, stable entry order, long-name grids, and independent attachment errors/pending states.
- [x] Implement native source dots and card grids. Preserve the measured-width map mounting gate, existing sensor route/hover behavior, and sensor-only GPX/TCX eligibility.
- [x] Add paired mobile Storybook states matching the web cases. The web map adapter must represent supplied coordinates so separate dots can be inspected.
- [x] Run focused mobile tests and mobile typecheck; review behavior against the specification.

Run: `pnpm exec vitest run --project mobile packages/mobile/components/RouteMap.test.tsx packages/mobile/components/ClimbingLogEntryCard.test.tsx packages/mobile/components/ClimbingLogEntryBreakdown.test.tsx packages/mobile/components/UnattachedClimbingLogEntries.test.tsx packages/mobile/.storybook/mocks/react-native-maps.test.tsx 'packages/mobile/app-tests/activity/[id].test.tsx'`.
Expected: all selected tests pass.

### Task 3: Storybook validation and delivery

**Files:**

- Update `packages/web/README.md` and `packages/mobile/README.md` to identify the component stories and the explicit location-input boundary, citing source components and the design.

- [x] Inspect web and mobile Storybook previews for route-plus-dots, points-only, mixed-GPS grids, long names, Attach pending/error, and narrow/wide layouts. Check accessible labels and console errors; fix observed problems with focused regression tests.
- [x] Run `pnpm lint`, root and all package typechecks, relevant unit/mobile suites, and both Storybook production builds. Expected: every command exits successfully.
- [x] Review the complete change against this plan and its component-only scope.

Reproduce static checks and builds with the [repository scripts](../../../package.json):

```sh
pnpm lint
pnpm typecheck
pnpm --recursive --if-present typecheck
pnpm --dir packages/web build
pnpm storybook:web:build
pnpm storybook:mobile:build
```

For interactive review, use `pnpm storybook:web` and `pnpm storybook:mobile:web`. Append `?path=/story/<story-id>` to the preview's base URL. The following IDs match the current [web map stories](../../../packages/web/src/components/ActivityRouteMap.stories.tsx), [web log stories](../../../packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.stories.tsx), [web suggestions](../../../packages/web/src/pages/activity-detail/components/UnattachedClimbingLogEntries.stories.tsx), [mobile map stories](../../../packages/mobile/components/RouteMap.stories.tsx), and [mobile log stories](../../../packages/mobile/components/ClimbingLogEntryBreakdown.stories.tsx):

| Review case | Web story ID | Mobile story ID |
| --- | --- | --- |
| Source points without a sensor route | `activity-detail-activityroutemap--points-only` | `activity-routemap--points-only` |
| Sensor route and source dots | `activity-detail-activityroutemap--route-plus-dots` | `activity-routemap--route-plus-dots` |
| Repeated occurrence selection across a log without GPS | `climbing-log-entry-breakdown--repeated-point` | `climbing-log-entry-breakdown--repeated-point` |
| Mixed source locations | `climbing-log-entry-breakdown--mixed-gps` | `climbing-log-entry-breakdown--mixed-gps` |
| Narrow activity layout | `climbing-log-entry-breakdown--activity-detail-narrow` | `climbing-log-entry-breakdown--activity-detail-narrow` |
| Wide activity layout | `climbing-log-entry-breakdown--activity-detail-wide` | `climbing-log-entry-breakdown--activity-detail-wide` |
| Attachment pending/error states | `climbing-unattached-logs--attach-states` | `climbing-log-entry-breakdown--attach-states` |

### Task 4: Requested climbing copy refinement

The original component delivery included a request for more concise climbing summary copy. The later [canonical model cutover](../../climbing-log-model-cutover.md) retired that legacy formatter. Both card components now use [`formatClimbingRecordedResult`](../../../packages/format/src/climbing-log.ts) for the server's scoped whole-climb and pitch outcomes and recorded counts. Preserve those canonical summaries and the independent facts in the details disclosure; do not infer additional counts or outcomes in clients.

- [x] Preserve the canonical formatter and its [existing tests](../../../packages/format/src/climbing-log.test.ts) during base integration.
- [x] Verify the visible copy and scoped results through the web and mobile card/breakdown tests and the `climbing-log-entry-breakdown--unknown-execution` story on both platforms.

Run: `pnpm exec vitest run --project unit packages/format/src/climbing-log.test.ts packages/web/src/pages/activity-detail/components/ClimbingLogEntryCard.test.tsx packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.test.tsx` and `pnpm exec vitest run --project mobile packages/mobile/components/ClimbingLogEntryCard.test.tsx packages/mobile/components/ClimbingLogEntryBreakdown.test.tsx`.

Original delivery verification on 2026-10-13: 17,483 unit tests and 1,458 mobile tests passed, along
with lint, root/all-package typechecks, web production build, and both
Storybook production builds. Browser checks covered narrow/wide grids,
source-only and combined maps, source provenance, production occurrence
selection/card highlighting, keyboard access, lazy previews, Attach states,
and the requested copy. Native device rendering and VoiceOver were not audited.
