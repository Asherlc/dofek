# Shared Map Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each check below. Independent platform work may use superpowers:dispatching-parallel-agents.

**Goal:** Apply the approved subdued map style to all web/iOS interactive maps and thumbnails.

**Architecture:** One shared style factory in @dofek/training; MapLibre GL JS on web and MapLibre React Native on iOS. Server preview projection retains its viewport and overlay positions but returns center/zoom instead of raster tile URLs.

**Tech Stack:** TypeScript, MapLibre, OpenFreeMap, React, Expo, Vitest.

**Spec:** ../specs/2026-10-29-shared-map-style-design.md

## Global Constraints

- Stay on melodic-whale; no branch switching.
- Latest stable dependencies, exactly pinned; remove Leaflet/react-native-maps.
- Shared `@dofek/training/map-style`: `createMapStyle(mode: "light" | "dark"): StyleSpecification` and `mapAttribution` string.
- New mapPreview contract: `{ width: number; height: number; center: [number, number]; zoom: number; routePath: { x: number; y: number }[] | null }`. Center is longitude/latitude. Reference viewport remains 1024×576; existing sourcePoints x/y/location remains.
- Preserve source scope, clustered markers, chart hover, loading/error UX and accessibility.
- No new runtime env vars, custom map service or transitional API aliases.
- Existing preview output is untracked design material; exclude it from commits.

## Review Focus

- Thumbnail background and projected overlays align at different viewport sizes.
- Map updates preserve user camera position where existing behavior does.
- Compact maps do not intercept card navigation or create excessive active WebGL contexts.
- Theme changes apply the shared palette and preserve overlays.
- Unmounts, module import errors and tile/native map errors clean up and reach Sentry.

### Task 1: Shared style and preview camera contract

Files: packages/training/src/map-style.ts; packages/server/src/lib/map-preview.ts; contracts/activity-location.ts; all old osm-tile consumers and related fixtures.

Interfaces: produce createMapStyle and the mapPreview contract above; preserve osmPointMapPreview's projected source positions under canonical `pointMapPreview` and recorded routes under `routeMapPreview`.

- [x] Update projection tests first to cover the new camera and existing overlay coordinates; watch fail.
- [x] Implement shared style and server preview projection, remove raster URL generation; update callers.
- [x] Update all preview fixtures across server/web/mobile, preserving their relevant overlay examples.
- [x] Run focused server projection/repository/contract tests and shared package typecheck.

### Task 2: Web MapLibre migration

Files: ActivityRouteMap, ClimbingLocationMap, ActivityMapTile and related helpers, tests/stories, CSS/imports.

Interfaces: consume shared style and new preview contract. Preserve public component props.

- [x] Write/update behavior tests first for map initialization, selection, cluster zoom, errors, lazy compact rendering, hover markers and thumbnail camera/overlay alignment; watch fail.
- [x] Replace Leaflet maps with MapLibre and render thumbnails with the same style; preserve image-like noninteractive list behavior and bounded map resources.
- [x] Remove obsolete mocks/assertions; retain tests of user behavior and unsafe label escaping.
- [x] Verify focused tests, web typecheck/build and browser stories at specific story URLs.

### Task 3: Mobile MapLibre migration

Files: RouteMap, ClimbingLocationMapCard, ActivityMapTile; app.json; native map mocks, related tests/stories.

Interfaces: consume createMapStyle and new preview center/zoom; preserve RouteMap props and source/route SVG overlays.

- [x] Write/update behavior tests first for native initialization, selection, cluster zoom, loading/errors and thumbnail camera sizing; watch fail.
- [x] Migrate all native map components, Expo plugin and mocks; preserve attribution, gestures, chart hover and attachment behavior.
- [x] Remove react-native-maps config/dependency references; update route fixtures with root's fixture migration.
- [x] Verify mobile unit tests, typecheck, Expo export and native build where available.

### Task 4: Integration, review and shipment

- [x] Run relevant combined tests, typechecks, production web build/size check and mobile export/native checks.
- [x] Update web/mobile/shared READMEs with sourced architecture and build notes.
- [x] Conduct fresh review of the complete diff and fix important findings with regression coverage.
- [x] Commit and push to current remote branch automatically; report exact validation and remaining native verification limits.

## Working notes

- User approved implementation scope; proceed without another approval round.
- Review checkpoints: projection tests; platform tests; combined type/build checks; fresh final review.

- Final verification: 22,645 unit/mobile tests passed; typechecks, policy lint, spellcheck, web build and unchanged size limits passed. iOS Release simulator compilation exited 0 using isolated test configuration. Native runtime interaction remains a release audit requirement. Fresh mobile development Storybook also renders the shared map after the worker-global correction.
