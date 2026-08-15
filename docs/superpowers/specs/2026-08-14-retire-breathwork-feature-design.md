# Retire the Breathwork Feature

**Date:** 2026-08-14

## Goal

Retire Dofek's manually operated Breathwork product surface from the web app,
mobile app, and public server API while preserving all existing breathwork
session rows as historical read-only data.

## Scope

The active feature will be removed end to end:

- Remove the `/breathwork` web route and the corresponding Expo Router screen.
- Remove every web and mobile navigation entry that opens Breathwork.
- Remove Breathwork route stories and tests that cover the retired UI.
- Remove the `breathwork.*` tRPC router and its registration in the application
  router.
- Remove the server repository used only by that router.
- Remove the shared Breathwork technique, timing, and outcome-reporting module
  used only by the retired clients and API.
- Remove Breathwork-specific query-cache invalidation and active development
  seed generation.
- Update active documentation that advertises Breathwork as an available
  product or API surface.

No replacement page, redirect, compatibility endpoint, or disabled-state UI
will be added.

## Historical Data Preservation

This section records the intended pre-recovery design. Production evidence later
confirmed that deployed migration `0089_remove_cycle_tracking_and_breathwork.sql`
had already dropped `fitness.breathwork_session` and `fitness.menstrual_period`.
The deployed-state contract therefore keeps `0089` immutable, recreates both
canonical tables with forward-only migration
`0091_restore_retained_health_records.sql`, and restores the selected backup as
documented in the [retained health record recovery plan](../plans/2026-08-15-recover-retained-health-records.md).
The UI and mutation API retirement described here remains unchanged.

The restored `fitness.breathwork_session` and `fitness.menstrual_period` tables
stay represented by the canonical Drizzle schema in
[`src/db/schema/events.ts`](../../../src/db/schema/events.ts). No later migration
may drop, truncate, rename, or rewrite either retained table or its recovered
rows.

The application will have no Breathwork-specific mutation, repository, or UI
write path after this change. Historical rows may still be read through
general-purpose data export and operator/admin tooling so retained user data
remains portable and observable. Those generic paths must not create or modify
Breathwork sessions.

Fresh databases will continue to contain the historical table because it is
part of the baseline schema. Development seed cleanup may continue deleting
rows belonging to the disposable seed user, but seed generation and seed
verification will no longer create or require Breathwork sessions.

## Provider Data

Provider-level `breathwork` activity classification remains supported. Garmin,
WHOOP, Oura, and other provider parsing or canonical activity-type mappings are
outside the retired manual-session feature and will not be removed. This keeps
provider-ingested activities intact while eliminating human-entered Breathwork
sessions.

## Client Behavior

On both web and mobile, Breathwork will disappear from More, Recovery, and any
other navigation surface. Because the route files will be removed, direct
navigation to the old route will follow each client's normal unknown-route
behavior. The clients will not contain hidden forms, start/stop controls, or
manual check-in controls for Breathwork.

## Server Behavior

The root tRPC router will no longer expose a `breathwork` namespace. Technique,
history, outcome, and session-logging procedures will all be removed together,
along with the repository and shared domain helpers that served them. Generic
administrative table accounting and user-data export remain because they are
data-preservation mechanisms rather than active Breathwork APIs.

## Testing and Verification

Tests for deleted source files will be deleted, and tests for shared navigation
or router registration will be updated to reflect the remaining active
features. No new test will assert merely that Breathwork is absent, consistent
with the repository rule against testing the absence of a removed feature.

Validation will include:

- focused web, mobile, server-router, seed, and export tests affected by the
  removal;
- repository lint and TypeScript checks;
- the Docker-free unit test tier;
- relevant database-backed integration tests if the changed seed or export
  paths require them;
- a final repository search confirming no active Breathwork UI/API references
  remain while schema, migration, export, admin, and provider-classification
  references are intentionally preserved.

## Non-Goals

- Deleting or transforming historical `fitness.breathwork_session` data.
- Removing provider-ingested breathwork activities or canonical activity types.
- Adding a replacement breathing feature.
- Adding a temporary redirect, compatibility API, or deprecation screen.
- Archiving the retained rows into a second table or storage system.
