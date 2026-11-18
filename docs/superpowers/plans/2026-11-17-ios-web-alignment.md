# iOS Overview, Navigation, and Activities Implementation Plan

> **For agentic workers:** Read the local development and test policies first. Follow this plan one task at a time. Observe each behavior test fail before writing the implementation, then review the diff and evidence before handing off.

**Goal:** Bring the iOS launch screen, navigation, Activities list, and activity detail into alignment with the approved sketches.

**Architecture:** Reuse the current Expo Router routes, native charts, provider selection, and tRPC contracts. The responsive web views supply the content and hierarchy reference. The iOS routes own native navigation and controls.

**Design reference:** The user approved the interactive Overview/navigation and Activities sketches in this thread, then requested implementation on November 17, 2026.

## Scope and constraints

- Primary tabs are Overview, Training, Activities, Sleep, and More, with alerts accessible from the tab header. More gives Body, Nutrition, Correlation, Data Sources, and Settings direct entry points.
- Overview shows processing and onboarding state where applicable, the key insight with data context, the seven-day resting heart rate trend, the Health Monitor, and a Last Night route to Sleep.
- Group existing training analysis by the web's sections. This work aligns navigation and available views. New sport analyses identified by the audit are separate product work.
- Activities has compact date and sport controls, an initially collapsed training-time summary, and the recent workout cards with readable route previews. Existing list selection, pagination, filtering, source lineage, imports, and state handling remain usable.
- Workout detail provides native back and an actions menu, an Overview section with key stats and appropriate route/climbs/exercises, Performance with a selected readable metric and its existing source control, and Details with source attribution. Preserve map-linked scrubbing, unit formatting, zones, chart data disclosure, media, and appropriate empty/loading/error states.
- Use the existing sources and semantics from web and mobile. The approved changes bring iOS up to the web reference. Keep web behavior stable apart from an evidence-backed common change necessary for parity.
- Preserve inbound links and routes used by other app flows. No new dependency, server API, database change, feature flag, or bespoke infrastructure is expected.
- Preserve the distinction between no data, reported zero, refreshing data, and failed requests. No fixture data or preview-only actions in the app.

## Review focus

- Opening a filtered or paginated workout then going back should retain the list and selection behavior.
- Activities without a route should keep their existing sport-specific cards and media handling.
- Changing metric or recording source should keep the correct chart cursor, map behavior, zones, and stale-data semantics.
- Existing links to Sleep, Recovery, Heart Rate, Nutrition, and Correlation should still reach useful screens.
- First-run, offline, loading, and refresh-error Overview states should show accurate data and keep actionable controls available.

## Tasks

### 1. Activities list

- [x] Extend `packages/mobile/app-tests/(tabs)/activities.test.tsx` to exercise an initially collapsed training-time chart, expansion, and the visible recent list while collapsed. Check filter and selection paths.
- [x] Run the test before edits and confirm the missing disclosure is the failure.
- [x] In `packages/mobile/app/(tabs)/activities.tsx` and the existing summary/heatmap components, form one compact date/sport control row with existing options. Place the compact summary immediately above the workouts and position the calendar inside its disclosure. Keep the existing server-backed activity totals and map cards.
- [x] Update existing Activities stories with collapsed and expanded states. Run the route and touched component tests and review the diff.

### 2. Workout detail

- [x] Add route tests in `packages/mobile/app-tests/activity/[id].test.tsx` for the actions menu, section navigation, metric and source selection, and map-linked scrubbing. Observe the expected failures.
- [x] Restructure `packages/mobile/app/activity/[id].tsx` using the existing header, actions, native map, stats, sport sections, and query hooks. Reuse the production export and mutation actions.
- [x] Use a single active metric inside Performance with existing source selection and chart-data disclosure. Keep route position visible where GPS exists. Move zones with the corresponding metric and preserve non-route behavior. Reuse existing components.
- [x] Update activity stories and run relevant route and component tests. Review scope and behavior against outdoor, indoor, climbing, and no-data fixtures.

### 3. Tabs and destinations

- [x] Write route tests for the five tab labels, More links, Training's grouped entry points, and existing links. Observe failures before edits.
- [x] Update `packages/mobile/app/(tabs)/_layout.tsx` and companion routes. Reuse Sleep, provider management, Settings, Nutrition, Correlation, Body/vitals and Heart Rate screens. Keep existing public Expo Router paths usable.
- [x] Group existing training charts under the web section names and carry the selected time range forward. Keep existing sport capabilities and make current entries useful.
- [x] Update navigation stories and route fixtures. Verify route discovery and default selection.

### 4. Overview

- [x] Extend `packages/mobile/app-tests/(tabs)/index.test.tsx` to verify insight, resting heart rate, monitor, and Last Night entry points, and offline/loading/empty/error rendering. Observe failures before edits.
- [x] Reorganize `packages/mobile/app/(tabs)/index.tsx`. Reuse the web's `dailyMetrics.trends`, `dailyMetrics.hrvBaseline`, and `insights.compute` contracts, existing formatting, health status data, and native chart/UI components. Retain localized Last Night and processing state from the current Today route.
- [x] Keep per-section errors and stale data, and retain targeted pull-to-refresh. Use touches or disclosures for evidence and data links.
- [x] Update the default and missing-data stories. Run route and involved component tests and review the diff.

### 5. Whole change

- [x] Review the complete branch separately after focused checks.
- [x] Run `pnpm lint`, `pnpm --recursive --include-workspace-root --if-present typecheck`, and the non-interactive unit and mobile suites. Verify the changed screen stories at phone width and export the iOS bundle.
- [x] Document the user-facing routes in the mobile README.
- Check Simulator navigation against an isolated account when the native build and local API are available.
