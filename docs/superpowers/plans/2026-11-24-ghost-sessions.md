# Ghost Sessions Implementation Plan

> Implement one task at a time with a bounded Paseo implementer. The lead reviews the actual changes and the failing and passing checks before committing and pushing each accepted increment.

**Goal** Automatically break an outdoor run or ride into meaningful stretches and compare it with the athlete's earlier recorded efforts.

**Architecture** Reuse canonical activity membership and route matching. Apply provenance eligibility before choosing location and sensor samples, then prepare matches in the bounded analytics worker. Geoapify supplies map names after opt-in and both clients consume one protected, server-computed comparison contract.

**Tech stack** TypeScript, ClickHouse and dbt, PostgreSQL settings, BullMQ, tRPC, React and Expo, MapLibre.

**Spec** [Approved Ghost Sessions design](../specs/2026-11-24-ghost-sessions-design.md).

## Global constraints

- Apply the development, test, and storage policies in the repository guides. Read the relevant package guides before editing.
- Only direct, independently sourced data may contribute to Ghost Sessions. Preserve existing source choices in other views. Never send Strava-origin coordinates, metrics, IDs, or derived results to Geoapify.
- Keep time and metric calculations server-owned. Retain elapsed pauses. Hold both routes and sections to the same recorded boundaries before reporting a personal best.
- Keep the activity detail request path bounded. Reuse the current refresh, visibility, settings, and erasure mechanisms. Run checks with `rtk` and `pnpm`.

## Review focus

- A canonical group has a direct GPS track, but the existing route view chose Strava. The direct track must still qualify. Task 2 covers source selection and deletion.
- Two trails run in parallel and meet at an intersection. Shared proximity alone cannot produce a comparison. Task 3 covers the ordered overlap and direction tests.
- Two prior workouts share different portions of a road. Each comparison uses its own common interval and cannot set a common personal best. Task 3 covers record scope.
- A long trace has a signal gap near a trail handoff. Map reconstruction must never generate a timed pass across the gap. Tasks 3 and 4 cover the GPS boundary and provider response.
- An athlete withdraws map permission while work is running. Task 4 covers worker publication, removal, and the freshly loaded activity. Task 5 covers both clients clearing the label while keeping the replay.

## Task 1 · Qualify Geoapify with public traces

**Working notes** Record a short, reproducible result in `docs/ghost-sessions.md`. Use the existing server-side `GEOAPIFY_API_KEY` concept documented in `deploy/README.md`. Do not log keys or use customer traces. [Geoapify map matching](https://apidocs.geoapify.com/how-to/routing/choose-map-matching-mode) · [Geoapify data processing agreement](https://www.geoapify.com/data-processing-agreement/)

- [ ] Check the production account's permitted use, quota, storage and attribution terms before sending personal coordinates. Use public road and trail traces to verify the walking or bicycling modes, a named trail, a named road, blank names, original waypoint mapping, and actual credit consumption. Send coordinates and travel mode only.
- [ ] Record the observed name field, stable or unstable edge identifiers, route-step coordinate index behavior, discontinuities, payload limit and workable chunk overlap. Freeze sanitized response examples for the adapter test. If the service cannot reliably identify named roads and trails or meet the agreed data handling, report the evidence to the lead for direction.
- [ ] Review the findings and pin the production dependency and batch limits only where the observed contract calls for them. This qualification may precede project deployment, with no customer data.

## Task 2 · Prepare eligible GPS and sensor evidence

**Files** `analytics/models/read_models/activity_location_sample.sql`, `activity_route_identity.sql`, `deduped_sensor.sql`, `activity_sensor_sample.sql`, their shared macros, and the existing activity-scoped build in `src/analytics/`. Add the Ghost Sessions read models and executable fixtures under `src/db/`. Reuse the existing membership and source ranking.

**Interface** The Ghost Sessions analytics pipeline supplies `GhostTrack` records keyed by user and canonical activity. Each record exposes sport and modality, ordered timed points, selected direct-source provenance, route quality and a refresh version. Selected pace, heart rate and power evidence carries coverage and provenance. Measurements reference recorded coordinates and timestamps.

- [ ] Add failing ClickHouse fixture cases for an independently recorded GPS activity selected behind a preferred Strava copy, a Strava-only activity, direct sensor samples that lose ordinary source selection, a normal outdoor road run, an indoor ride, and a group losing its only eligible recording. Assert the eligible route and sample source IDs, and verify that the ordinary views keep their observed winners.
- [ ] Use existing scoped normalization and deduplication before selecting eligible source winners. Apply the Ghost Sessions eligibility predicate before location and scalar winners are selected. Reuse the source selection expression through the narrowest shared SQL surface. Keep the candidate population to eligible owned outdoor runs and rides. Build from affected membership and source watermarks, and invalidate removed records. For stored analytic results use the existing incremental or projector pattern, including a separate bounded input checkpoint for history.
- [ ] Run the same ClickHouse tests, including refresh replay and deletion. Run `rtk proxy pnpm lint:analytics-policy` and `rtk proxy pnpm lint:analytics-sql`. Review the selected source IDs and unchanged output for existing consumers before committing.

## Task 3 · Match, measure and serve ghosts

**Files** `src/analytics/ghost-sessions-projector.ts`, `packages/training/src/ghost-sessions.ts`, `packages/server/src/repositories/ghost-sessions-repository.ts`, `packages/server/src/routers/ghost-sessions.ts` and `packages/server/src/router.ts`. Use `packages/server/src/repositories/route-equivalence.ts` as the complete-route matching owner. If worker reuse requires moving the matcher, move it to the shared domain package and preserve all existing callers through their imports and tests.

**Interface** `ghostSessions.get({ activityId })` returns eligibility, processing and coverage, route and stretch summaries, and suggested pass identity with reason. `ghostSessions.passes({ activityId, sectionId, cursor })` returns a stable page ordered newest first. `ghostSessions.compare({ activityId, sectionId, passId })` returns the server-computed two-pass elapsed result, optional covered metrics, and synchronized progress positions. First visits have one recorded effort and no `passId`. Section and pass IDs are scoped to the authorized activity. Use a Zod contract at each boundary.

- [ ] Write failing cases for a forward repeat with a shifted start, a reverse pass, a different lap count, a same-direction loop with a materially different start, intersecting and parallel paths, an out-and-back, two passes in one workout, a short shared stretch within longer different routes, and both complete and partial GPS coverage. Include two overlaps with different boundaries, a first visit during incomplete history, a newer slower prior pass and an older best, and lack of playback or sensor coverage. Assert exact fixture time differences and default ghost IDs.
- [ ] Extend complete-route equivalence only for this consumer's same-direction and lap rules. Compute shared stretches with ordered contiguous alignment of nearby eligible samples and time passage at common endpoints. Establish conservative overlap and quality thresholds against the test traces and record the measured choices. Generate unnamed climbs from available recorded elevation. Use spatially relevant owned candidates and explicit work limits. Prepare intervals, replay samples, and expensive measurement results off requests. Preserve a coverage bound for bounded historical processing and qualify any claims before it reaches complete eligible history.
- [ ] Return existing share-safe activity IDs and enforce entitlement and visibility for anchor and candidates. Validate that requested sections and pass IDs resolve within the authorized anchor. Below-sufficient sensor coverage returns null for the affected comparisons. Ensure duplicate imports cannot count as distinct passes. Test wrong-owner, erased, and unavailable IDs and exact replay positions against real-engine fixtures.
- [ ] Run unit and integration tests for the new match, router and projector, plus existing route-equivalence and hiking comparisons. Review candidate bounds, rebuild/deletion handling and first-visit/record labels before committing.

## Task 4 · Enrich road and trail names after opt-in

**Files** `src/analytics/ghost-route-labels.ts`, the existing post-sync and analytics refresh owners under `src/jobs/` and `src/analytics/`, `packages/server/src/routers/settings.ts`, `packages/server/src/repositories/settings-repository.ts`, and the existing erasure registry. Add targeted integration coverage and `docs/ghost-sessions.md` operator guidance.

**Interface** Add a default-off `ghostMapLabels` boolean through the existing Settings API. The worker maps a canonical eligible geometry, a geometry version and permission state to `GhostMapSection[]` with recorded bounds, name, trail or road type, attribution and coverage. The API returns an explicit map-label state while continuing to serve matching from recorded geometry.

- [ ] Use MSW response examples from Task 1 in failing tests. Assert reviewed name and coordinate/index paths, valid retained pieces after a gap, omitted ambiguous names, deterministic chunk overlap, and explicit responses to rate limits and malformed data. Assert that a disabled user generates zero provider calls and that all requests contain only eligible coordinates and travel mode. In a real database-backed test, withdraw permission and remove a direct data source during a job and assert stale labels cannot publish or survive the lifecycle event.
- [ ] Enqueue new eligible workouts after permission is granted. For older runs and rides, use an explicitly bounded existing-workout enrichment request on detail access. Do the map API work in the worker. Deduplicate jobs by canonical activity and geometry version, and recheck ownership, scope, permission, and version before consuming or publishing results. Acknowledge and expire labels through the existing source and account deletion paths. Preserve vendor attribution and use recorded time and boundaries for every matched metric.
- [ ] Run adapter, job, settings, and removal tests and confirm both clients will receive the same label state. Validate the existing key's worker environment in Infisical. Apply repository infrastructure validation before pushing any deployment change. Audit one successful public-trace enrichment and verify that a vendor failure leaves the base comparison usable.

## Task 5 · Add the activity-detail experience on web and iOS

**Files** `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/web/src/components/GhostSessions.tsx`, `packages/mobile/app/activity/[id].tsx`, `packages/mobile/components/GhostSessions.tsx`, both settings surfaces, and their colocated tests and stories. Use the existing `ActivityRouteMap` and `RouteMap` primitives. Add review fixtures to the existing activity-detail fixture locations.

- [ ] Write client tests for default ghost selection, picking a different prior effort, selecting named road and trail rows, synchronized replay and screen-reader labels, original-activity links, first visit, processing, partial history, missing metrics, and a distinct map-label error. Assert that turning map labels off clears visible or persisted name data while route matching remains available.
- [ ] Add a Ghost Sessions section to eligible activity details using the preview interaction. Keep the first view to the comparison, replay and a compact list of stretches. Use the shared contract and current display units. Add the opt-in disclosure on each platform, with the exact data flow and ability to turn it off. Keep the last usable comparison during background refresh and invalidate relevant caches after changes or withdrawal. Publish primary, loading, empty and error Storybook stories for both clients.
- [ ] Run focused unit and mobile tests and inspect the named stories at desktop and handset widths. Verify keyboard and touch interactions and the meaningful stable and changed states.

## Task 6 · Validate the full change

- [ ] Run `rtk proxy pnpm lint`, `rtk proxy pnpm --recursive --include-workspace-root --if-present typecheck`, focused unit/mobile tests and the real ClickHouse integration tier covering the whole change. Apply and verify any migrations with the documented workspace environment. Use targeted fixture and build verification for native dependencies where applicable.
- [ ] Independently review the complete diff, then exercise the main flow with synthetic direct-provider runs and rides. Verify projected names, cross-source direct GPS matching, first visits, history controls, erasure, and the vendor call boundary. Resolve material findings and rerun affected checks before pushing.
- [ ] Update the runbook with verified processing limits and an operator-bounded history procedure. Remove transitional diagnostics before release. Check CI against the pushed head and report the exact validation evidence and anything still gated.
