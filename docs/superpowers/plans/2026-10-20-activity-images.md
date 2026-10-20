# Activity Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep private copies of every distinct image exposed for connected provider activities, including historical activities and every contributing source.

**Architecture:** Store original image bytes in a dedicated private R2 bucket and source associations in Postgres. Discover through provider adapters, acquire through durable BullMQ work, and serve a grouped gallery through the existing authenticated API. Reuse existing R2, outbox, provider throttling, visibility, and erasure mechanisms.

**Tech Stack:** TypeScript, Drizzle/Postgres, AWS SDK/R2, BullMQ/Redis, tRPC, Vitest, existing Terraform deployment.

**Spec:** [Approved design](../specs/2026-10-20-activity-images-design.md).

## Global Constraints

- Download the highest resolution the provider exposes; distinct images and edited images remain distinct assets.
- Do not upscale, recompress, or discard original metadata while copying the selected file.
- Never share objects between user accounts; preserve every provider association.
- Enumerate all pages of any verified gallery endpoint; unsupported and partial coverage are explicit.
- Use the existing SDK, R2 client, durable dispatch, provider throttling, and erasure fences.
- No gallery redesign, thumbnail subsystem, video capture, manual uploads, or generated cards.
- No branch switching without approval. Use the current isolated checkout if suitable.
- Node >=26 and the repository-pinned pnpm are required; inspect current package metadata at execution.
- New required runtime configuration must exist in Infisical before deployment.
- No speculative provider endpoints or claims of live validation from fixture tests.

## Review Focus

- Redirects, DNS changes, and signed CDN URLs must not expose credentials or reach private networks (Task 2).
- A stale acquisition must not overwrite a newer image revision or defeat deletion (Tasks 1, 3, 6).
- Empty or partial pagination and a photo count larger than discovery must not imply complete coverage (Task 4).
- Provider disconnection or an unavailable historical activity must leave existing copies intact and backfill resumable (Tasks 4, 5).
- Merge/split operations and shared bytes must retain provenance and delete only unreferenced objects (Task 6).

## Execution and review rules

Execute the six dependent tasks in order. Each task uses the red/green test
cycle below, receives a focused review, and ends in a commit. Do not commit
unrelated changes. Before a push, complete the checks required by root
AGENTS.md; do not bypass a failed check. Provisioning or missing credentials
must be reported as blocked, never replaced with a silently disabled feature.

All new directories receive README.md, AGENTS.md, and its required symlinks.
Keep modules below 1,000 lines. Read directory guidance before each task.
File paths below are exact except generated migration names: use the next
Drizzle-generated migration and journal entry, never invent a sequence number.

### Task 1: Persist image identities, revisions, and durable work

**Files:** Create `src/db/schema/activity-images.ts`, `src/db/activity-images.ts`,
`src/activity-images/types.ts`, `src/db/activity-images.integration.test.ts`;
modify `src/db/drizzle-schema.ts`, package exports in `package.json`, generated
`drizzle/` migration/journal, and generated schema diagrams.

**Interfaces:** Define `ProviderImageCandidate` with `sourceId`, `kind`
(`photo | screenshot | class_artwork`), `caption: string | null`, `position`,
`variants: Array<{ url: string; width: number | null; height: number | null }>`,
`revision: string | null`, and `raw: Record<string, unknown>`.
Define `ImageDiscovery` with `coverage: complete | partial | unavailable | failed`,
`expectedCount: number | null`, `reason: string | null`, and `images`.
Repository exports `recordActivityImageDiscovery(db, {userId, activityId,
providerId, discovery}): Promise<void>` and `listPendingActivityImageWork(db,
limit: number): Promise<ActivityImageWork[]>`. Work contains user, provider,
activity, image identity, and monotonically increasing revision generation.

- [ ] Write constraint/lifecycle tests: two providers with the same hash retain two associations and one user-owned object; a different user has a separate object; cross-user references fail; URL rotation updates one source identity; discovery and outbox commit atomically; stale revision completion changes zero records.
- [ ] Run `pnpm vitest run --project integration src/db/activity-images.integration.test.ts`; expect missing schema/repository failure before implementation, not an infrastructure-only failure. If services are unavailable, leave executable tests for CI and state that the red/green database proof is unavailable locally.
- [ ] Implement object, source-image, discovery-coverage, outbox, and backfill-checkpoint persistence. Store ownership and generation constraints in Postgres. Keep image acquisition state separate from existing-copy availability, so refresh failures do not hide a stored copy. Outbox jobs are keyed by immutable work UUID, allowing later rediscovery to create fresh work after terminal failures.
- [ ] Run the integration tests with services and generate/check diagrams using `scripts/generate-schema-diagram.ts` through the repository toolchain. Expected: all ownership, atomicity, and stale-write assertions pass.
- [ ] Review and commit as `feat: persist provider activity image sources and work`.

### Task 2: Copy validated originals to private R2

**Files:** Create `src/activity-images/download.ts`, `src/activity-images/storage.ts`,
their colocated `.test.ts` files, and `src/activity-images/storage.integration.test.ts`;
modify `deploy/storage.tf`, `deploy/stack.yml`, deployment documentation, and
the existing required-environment inventory used by the deployment.

**Interfaces:** `downloadActivityImage(input: {url: string; signal?: AbortSignal;
allowedOrigins: string[]}): Promise<DownloadedImage>` returns a temporary file
path, SHA-256, MIME type, bytes, dimensions, and `cleanup(): Promise<void>`.
`storeActivityImage(input: {userId: string; image: DownloadedImage}):
Promise<{objectKey: string}>` uses the existing `createR2Client()`.
`createActivityImageUrl(objectKey: string): Promise<string>` returns a
five-minute signed GET URL; authorization is the caller's responsibility.

- [ ] Write tests asserting original bytes are unchanged, exact hashes match, identical bytes converge within an account, separate users have separate keys, and upload failure never returns success. Test a redirect to a private address, redirect loops, DNS rebinding, truncated bodies, false MIME types, oversized images, and cleanup on failure.
- [ ] Run `pnpm vitest run --project unit src/activity-images/download.test.ts src/activity-images/storage.test.ts`; expect missing implementation failures.
- [ ] Implement bounded streaming with a 50 MiB maximum, a two-minute request deadline, at most three redirects, and a 100-million-pixel ceiling. Use a maintained existing image parser; evaluate an off-the-shelf parser before adding any dependency. Accept validated JPEG/PNG/WebP/GIF/AVIF/HEIF originals where the parser supports them, preserve animation and EXIF bytes, and report unsupported formats explicitly. Pin DNS resolution to validated public addresses for each request; never send provider auth to image/CDN origins. Include tests for each accepted format and private IPv4/IPv6 address forms.
- [ ] Provision design: bucket `dofek-activity-media`, required binding `ACTIVITY_MEDIA_R2_BUCKET`, no public access or object-age expiry. Reuse R2 credentials. Stage Terraform/deploy changes without applying production infrastructure; ensure Infisical binding is configured before any deployment. Document limit failures as visible terminal states rather than silently dropping assets.
- [ ] Run unit and real object-store integration tests. Expected: byte-for-byte originals, isolated keys, working signed GET, and explicit upload failures. Review and commit as `feat: store private activity image originals in R2`.

### Task 3: Acquire and reconcile images durably

**Files:** Create `src/jobs/activity-image-outbox.ts`,
`src/jobs/process-activity-image-job.ts`, `src/jobs/activity-image-reconciliation.ts`,
their colocated tests and a processor integration test; modify
`src/jobs/queues.ts`, `src/jobs/worker-queues.ts`, `src/jobs/worker.ts`, worker
lifecycle registration, and the Task 1 repository.

**Interfaces:** `processActivityImageJob(db, work: ActivityImageWork):
Promise<void>`; `dispatchActivityImageOutbox(db, queue, limit = 100):
Promise<number>`; `reconcileActivityImages(db): Promise<void>`.
Add queue name `activity-images` and job data `{workId: string; userId: string}`.
Database work, not Redis payload URLs, is authoritative.

- [ ] Write tests for Redis outage after discovery, duplicate delivery, upload success followed by database failure, expired source-link refresh, source revision changing mid-download, and worker crash recovery. Assert exactly one current ready association and no stale write. Verify logs contain no signed URLs or credentials.
- [ ] Run `pnpm vitest run --project unit src/jobs/activity-image-outbox.test.ts src/jobs/process-activity-image-job.test.ts src/jobs/activity-image-reconciliation.test.ts`; expect missing processors.
- [ ] Implement dispatch every five seconds in batches of 100, following the existing file-upload outbox. Use four total worker slots, at most one acquisition per user/provider, five attempts with exponential backoff starting at 30 seconds, and provider Retry-After as a floor. Acquire the existing user/provider work lock and erasure barrier. Record processing lease, attempts, sanitized failures, and generation-checked completion. Temporary failures keep any previously stored image accessible.
- [ ] Reconcile every five minutes: retry processing leases stale for 15 minutes; recover undispatched work; enqueue unreferenced-object deletion with a one-day grace period. Coordinate claims and deletion against object references so cleanup cannot delete a concurrently attached image. Do not scan a whole bucket on request paths.
- [ ] Run processor integration tests with real Postgres and object storage, plus unit tests; expected: durable handoff, bounded retries, no false ready states, and safe cleanup. Review and commit as `feat: acquire activity images through durable background jobs`.

### Task 4: Discover all exposed images from provider adapters

**Files:** Create `src/activity-images/providers.ts`,
`src/activity-images/providers.test.ts`, `src/activity-images/providers/peloton.ts`,
`src/activity-images/providers/strava.ts`, adapter tests, and
`docs/activity-images.md`; modify `src/providers/types.ts`,
`src/providers/peloton.ts`, `packages/peloton-client/src/types.ts`,
`packages/peloton-client/src/parsing.ts`, `src/providers/strava.ts`, and their
existing tests. Add verified adapters for other providers only after audit.

**Interfaces:** Add optional `discoverActivityImages(run: SyncRun,
activityExternalId: string): Promise<ImageDiscovery>` to the sync provider
contract. `discoverAndRecordActivityImages(run: SyncRun, activityId: string,
activityExternalId: string): Promise<ImageDiscovery>` calls the adapter and
Task 1 repository; missing adapters produce unavailable coverage with a reason.
`refreshActivityImage(work: ActivityImageWork): Promise<ProviderImageCandidate>`
uses current per-user credentials and stable identity; Task 3 uses it for expired links.

- [ ] Write fixtures with three distinct images, multiple resolutions, signed URL rotation, caption/order, null primary, count larger than discovery, second-page failure, and a repeated pagination cursor. Assert every unique source identity is preserved, the largest available variant is chosen, and incomplete discovery is never complete.
- [ ] Run focused Peloton/Strava and new adapter unit tests; expect missing image fields and discovery methods.
- [ ] Audit every production provider that writes activity rows against current primary documentation or directly inspected client source. Record evidence URL, observed image fields/endpoints, auth, pagination, rate limits, and validation level in `docs/activity-images.md`. Inspect the production registry rather than freezing a provider list into this plan. Implement each evidenced image path; record unsupported/unverified cases explicitly. Do not call a guessed gallery endpoint to satisfy a count.
- [ ] Preserve Peloton class image fields and Strava detail payloads; discover during regular and webhook sync under the existing provider context. Catch and report media-specific errors separately from workout persistence, retaining failed coverage for retry. A primary-only Strava result with count >1 must remain partial until a verified gallery path supplies the rest. Do not synthesize original-provider provenance for screenshots returned by Strava.
- [ ] Run all changed provider unit tests and sync integration tests. Expected: every fixture image discovered, no additional workout failure from media errors, and raw source attribution intact. Review provider claims against citations and commit as `feat: discover provider activity images with explicit coverage`.

### Task 5: Backfill historical images with resumable progress

**Files:** Create `src/jobs/process-activity-image-backfill-job.ts`, its unit and
integration tests, `scripts/backfill-activity-images.ts`, and its test; modify
Task 1 checkpoint repository, queue/worker wiring, and `docs/activity-images.md`.

**Interfaces:** Backfill job data `{userId: string; providerId: string;
runId: string}`. `processActivityImageBackfillJob(db, data): Promise<void>`
uses a durable `(startedAt, id)` cursor and a high-water mark for the run.
`getActivityImageBackfillProgress(db, userId: string, runId: string)` returns
counts of scanned/discovered/stored/failed records and discovery coverage.

- [ ] Write tests with historical records before the recent-sync window, more than 100 records, equal timestamps, mid-page interruption, rate limits, disconnected providers, erased users, and source activities no longer retrievable. Assert no missing/duplicate records after resume and preservation of already stored copies.
- [ ] Run focused backfill tests; expect missing worker/script.
- [ ] Implement pages of 100 source activities through the existing provider queue and locks. Persist cursor and continuation work atomically; reuse Task 4 discovery and Task 3 acquisition. Mark unsupported or disconnected sources explicitly and allow a new run after reconnect; do not repeatedly enqueue unavailable work. New activity sync proceeds independently of the historical high-water mark.
- [ ] Implement CLI `pnpm tsx scripts/backfill-activity-images.ts --user-id <uuid> [--provider-id <id>]` and `--status <run-id>`. Require explicit user selection, never default to all accounts. Counters distinguish discovery success from completed copies.
- [ ] Run unit/integration tests and a fixture backfill interrupted and resumed twice; expected: stable counts, no duplicate objects, and accurate partial coverage. Review and commit as `feat: backfill historical activity image copies`.

### Task 6: Serve owned images and complete deletion lifecycle

**Files:** Create `packages/server/src/repositories/activity-images-repository.ts`,
its integration test, `src/account-erasure/activity-image-storage.ts`, its tests,
and `src/jobs/activity-image-deletion.ts` with tests; modify
`packages/server/src/routers/activity.ts` and its tests, existing activity deletion
repository transaction, `src/jobs/account-erasure-runtime.ts`,
`src/jobs/account-erasure-work-purger.ts`, erasure inventory/snapshot and restore
reconciliation tests, and `docs/account-erasure-runbook.md`.

**Interfaces:** `listActivityImages(db, {userId, activityGroupId})` returns
stored object metadata with all visible source associations and coverage;
router `activity.images({id: uuid})` resolves the owned group and signs URLs
only after authorization. `retireActivityImages(db, {userId, activityIds})`
retires associations transactionally; `eraseActivityImageObjects(userId: string):
Promise<void>` performs paginated user-prefix deletion and verifies absence.

- [ ] Write integration tests for cross-account requests, hidden/tombstoned/deleted activities, alias group resolution, merge then split, shared image deletion, and unknown IDs. Assert denied requests never call the signer. Test caption/EXIF preservation and all-source provenance in the returned metadata.
- [ ] Add erasure race tests: pause an upload, start erasure, resume upload, and assert no object or queued continuation survives the work barrier and final sweep. Restore a pre-erasure database fixture and verify reconciliation cannot reacquire media for the erased user. Test paginated object deletion and retry after R2 failure.
- [ ] Run focused API and erasure tests; expect missing list/retirement/purge behavior.
- [ ] Implement authenticated grouped reads using both activity visibility predicates. Return one displayed image per user-owned object with every visible source association. Keep provider-absent archives and disconnected-provider copies; explicit Dofek deletion retires affected associations and deletes only unreferenced objects. Block stale work from recreating them. Include bucket/user prefix in erasure inventories and perform purge under the existing account-erasure coordination.
- [ ] Run targeted unit/integration checks, then root `pnpm lint`, all required package typechecks, and applicable unit suites per AGENTS.md. Use `mise run test:sandbox` only where the documented cloud constraints apply; integration tests require real services. Never claim live gallery access or erasure integration passes if those checks could not execute.
- [ ] Document actual coverage, operational limits, backfill/status commands, and retention in `docs/activity-images.md`; link from `docs/README.md`. Confirm private bucket/configuration readiness before deployment. Review the complete branch against the approved spec, then commit as `feat: serve activity images and erase private copies safely`.

## Completion evidence and known environment limits

The design-doc session ran root/server/web TypeScript checks successfully.
`pnpm lint` failed before linting on a sandbox-denied tsx IPC socket, and the
available default Node was 24 despite the repository requiring >=26. These
are observations, not permission to bypass checks or reuse their results for
implementation. Resolve toolchain/runtime access at execution and report any
remaining checks that CI must perform. Authenticated provider validation and
production provisioning have not been performed.

Coverage review must map each approved spec section to Tasks 1–6. Universal
coverage is not established by implementing only Peloton and Strava: every
registered activity provider must have an evidence-backed capability entry,
and every verified image path must be collected. Explicit partial/unavailable
entries disclose upstream limits rather than claiming missing images were saved.

## Execution and validation

Implemented on branch `work`, including the final review fixes: failed-job
redrive, delayed transient-discovery retries without losing checkpoints, live
Zwift URL refresh, preservation of Strava detailed raw metadata, and the database
ownership-test fixture correction. Migration 0153 adds the durable backfill retry
deadline. Sandbox lint, migration policy, and root/server/web TypeScript checks
pass. Relevant unit regressions run directly on Node 26.12.0.

Database/R2/Redis integration tests are written but cannot be certified in this
workspace: Docker and TEST_DATABASE_URL are unavailable. Analytics SQL lint needs
ClickHouse; Terraform/stack validation needs deployment services and Infisical.
The branch is not pushed or deployed until those required checks can run. Other
providers' galleries remain explicitly unverified in the coverage matrix.

Retrospective: independent review and failure-path reproductions caught retry
and refresh defects. A provider-media contract checklist with sample payloads,
URL-expiry behavior, pagination, and retention permissions would make future
adapters faster to investigate; add it to the provider integration documentation
and reuse the systematic-debugging and verification skills.
