# KAYA Ascent Photos Implementation Plan

> **For agentic workers:** Use the executing-plans workflow, with independent provider, API, and client work delegated through dispatching-parallel-agents. Track tests and review checkpoints below.

**Goal:** Import KAYA ascent photographs and display private stored copies on both clients, including standalone climbs.

**Architecture:** Extend existing image associations and discovery rows to accept either an Activity or ClimbingLogEntry. Keep the existing objects, outbox, acquisition, cleanup, and erasure pipeline. Discover from KAYA's already complete sync feed, so the next sync also discovers historical ascent photographs without a second scan service.

**Tech Stack:** TypeScript, Drizzle/Postgres, BullMQ, R2, React, React Native, Vitest.

**Spec:** [Approved scope](../specs/2026-10-26-ascent-photos-design.md).

## Global constraints

- KAYA only; photographs only; no video thumbnails or route-gallery inference.
- One image association table, one object store, one work ledger; no new dependencies or environment variables.
- Account ownership, provider identity, provider absence, disconnect, account erasure, and source attachment changes must remain correct.
- Preserve original bytes and existing activity photo behavior.
- Write failing behavior tests before implementation; database semantics require real Postgres tests.

## Review focus

- A photo replaced on the same ascent must schedule a new generation without treating signed-URL rotation as replacement.
- Missing/malformed photo fields must not claim complete empty discovery or destroy stored copies.
- Standalone ascents and historical ascents must enqueue photos on normal sync without per-ascent provider list requests.
- Provider absence must hide/pause photos and reappearance restore them; disconnect retains stored copies.
- An image referenced by a retained climbing log must survive activity deletion, detachment, and cleanup.

## Task 1: Shared owner model and persistence

**Files:** `src/db/schema/activity-images.ts`, `src/db/schema/climbing.ts`, migration 0167, `src/db/activity-images.ts`, `src/activity-images/types.ts`, corresponding integration/unit tests.

**Interfaces:** Add `recordClimbingImageDiscovery(db, {userId, climbingLogEntryId, providerId, discovery})`. Keep `recordActivityImageDiscovery` intact. Acquisition work is a union of existing activity work and climbing work with `activityId: null`, `climbingLogEntryId: string`, and the source log external ID in `activityExternalId`.

- [x] Write/run failing Postgres tests for standalone ownership, foreign owner/provider rejection, exactly one owner, generations, absence/restoration, shared object lifetime, and cascade cleanup.
- [x] Extend association/discovery tables with owner foreign keys, exclusivity checks, and per-owner unique indexes. Preserve existing activity data.
- [x] Share discovery persistence; branch acquisition visibility/locking on the actual owner. Keep cleanup and erasure operating on the shared associations.
- [x] Run focused integration tests plus existing activity acquisition tests; inspect migration/schema diff.

## Task 2: KAYA discovery and refresh

**Files:** `packages/kaya-client/src/client.ts`, `src/providers/kaya-sync.ts`, provider media helper, `src/providers/types.ts`, `src/activity-images/providers.ts`, colocated unit and provider integration tests, `docs/kaya.md`.

**Interfaces:** `discoverClimbingImages(run, externalId, {refresh?: boolean}?)` on sync providers returns `ImageDiscovery`; KAYA implements it for verified ascent IDs. Sync calls Task 1's climbing discovery writer after corresponding logs exist.

- [x] Write/run failing tests for requested photo fields, nullable/omitted/malformed photos, full versus thumb alternatives, stable source identity, replacements versus signed-URL rotation, and standalone/historical sync.
- [x] Request `photo { photo_url thumb_url }`, retain raw media, and record discovery from the already-fetched complete ascent feed. Never call a list endpoint per ascent during sync.
- [x] Route expired-image refresh to climbing discovery using verified provider queries; report unexpected failures to Sentry. Validate source selection against current KAYA application evidence.
- [x] Run focused client/provider tests and real database sync tests.

## Task 3: Authorized API and shared gallery contract

**Files:** `packages/server/src/repositories/activity-images-repository.ts`, climbing image repository, `packages/server/src/routers/climbing.ts`, `packages/training/src/activity-images.ts`, repository/router tests.

**Interfaces:** `climbing.images({id: logEntryId})` returns the existing gallery output, with nullable source `activityId` and optional `climbingLogEntryId`. Activity galleries also read visible log-owned photos through current attachments without copying associations.

- [x] Write/run failing real database tests for owner isolation, absent logs, entitlement windows, attachment changes, source metadata, and deduplicated shared objects.
- [x] Reuse gallery consolidation and signing. Add the protected climbing query with Zod input/output; never expose upstream URLs to clients.
- [x] Run repository/router unit and integration tests.

## Task 4: Web/mobile galleries

**Files:** Both platforms' `ClimbingLogEntryDetails.tsx`, climbing photo query wrapper components and stories/tests, existing gallery components only where required.

**Interfaces:** Use Task 3's `climbing.images({id})` with `ACTIVITY_IMAGES_QUERY_OPTIONS`, and reuse `ActivityPhotos`/`ActivityImages` renderers.

- [x] Write/run failing tests for stored photos, full viewer, loading/pending, errors with retry, stale photos during refetch, and empty states on both clients.
- [x] Connect galleries only for KAYA ascent records; keep list cards concise and query URLs out of persisted mobile caches.
- [x] Verify web/mobile tests and inspect representative stories visually through a tunneled Storybook server if starting HTTP development servers.

## Task 5: Integration, documentation, and review

- [x] Update active photo/KAYA docs with scope, next-sync historical discovery, and observed live-validation limits. Regenerate schema diagrams.
- [x] Run unit/mobile suites, focused integration suites, typechecks, applicable lint/migration checks, and inspect all failures.
- [x] Obtain a fresh whole-change code review, fix material findings with regression tests, and record review outcomes.
- [x] Commit and push changes; report verified behavior, limitations, and a short retrospective.

## Working notes

- Scope ruling: next normal KAYA sync performs historical discovery using its existing full logbook fetch. This avoids a new service and quadratic requests; no historical creation-time scan is implemented.
- Review checkpoint: design builder review found no blocking gaps before KAYA scope narrowing.
- Task 1: Postgres red run failed on missing climbing discovery writer; green 9/9 persistence tests. Existing acquisition/erasure integration also passed.
- Tasks 2–3: provider/client 141 unit tests and 15 sync integration tests; API focused units and 8 gallery integration tests passed. Consolidation/privacy regressions subsequently passed 165 focused units and 22 hydration integration tests.
- Task 4: 240 client/detail/attachment tests passed. Chrome Storybook checks passed for both renderers, including pending, errors, stale photos, viewer, and incomplete discovery. Mobile visual validation used React Native Web, not Simulator.
- Review checkpoint: fixed all four material findings with failing regressions first: consolidated source photo ownership, targeted image invalidation on attachment, upstream media redaction in detail responses, and incomplete discovery visibility.
- Ruling: use one nullable server-derived `photoLogEntryId` for current KAYA-only consolidation; the existing grouping permits at most one source per provider, so a collection of photo owners is unnecessary.
- Ruling: advance the mobile persisted-query contract to version 14 because older climbing detail payloads lack the new required source-owner field; signed photo queries continue opting out of persistence.
- Ruling: an expired-link refresh records updated discovery before the worker compares revisions. A changed revision schedules new work and cannot be stored under the old generation; unchanged terminal failures are not promised automatic recovery by another sync.

- Final verification: 21,555 unit/mobile tests passed (19 skipped); 55 focused integration tests passed; root/server/web/mobile typechecks passed; full lint and PostgreSQL migration SQLFluff/policy checks passed; schema diagrams regenerated; local analytics build passed 45/45 models after canonical workspace bootstrap. No material review findings remain deferred.
- Merge preparation: preserved the KAYA send-status and canonical-setting changes from main together with photo behavior and both regression suites. Renumbered the unchanged photo migration from 0164 to 0167 after main allocated 0164–0166; its approved exceptions remain confined to that migration. Focused checks passed 155 unit tests and 45 PostgreSQL integration tests.
