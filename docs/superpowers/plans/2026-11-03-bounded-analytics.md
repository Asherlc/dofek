# Bounded Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user explicitly approved Codex subagents; preserve that authorization and this conversation's worktree/branch.

**Goal:** Replace unbounded historical sensor discovery/reconciliation with durable complete-key pages, causal completion evidence and independently enforced temporary-storage limits.

**Architecture:** Keep the existing serialized analytics queue and dbt transformation ownership. The sink durably journals structural effects before acknowledging input; finite sensor/CDC frontiers feed bounded scalar, dedup and activity stages, each writing output and downstream effects before its cursor. Physical filesystem limits remain independent of native query accounting.

**Tech Stack:** TypeScript/Node 26, PostgreSQL/Drizzle, ClickHouse/dbt, BullMQ, native Pulsar client, Vitest and real-engine integration fixtures; native ext4 project quotas for the proposed production storage boundary.

**Spec:** [Approved bounded analytics amendment](../specs/2026-11-03-bounded-analytics-design.md). The user approved it with “Y” after reviewing commit `d0b39c0c8`. This extends, rather than replaces, the [Pulsar migration plan](2026-11-03-single-server-pulsar.md).

## Global Constraints

- Existing server only; no additional machines or managed messaging service.
- Preserve complete source candidates, current global UUID identity, nullable provenance, source versions, tombstones and account-erasure fences.
- Current-state reconciliation with causal coverage; no historical snapshot-at-seal promise. Later versions may be read, but their effects cannot disappear from later-operation coverage.
- Keep analytics-refresh, sync-ride-with-gps and sync-strava paused and the history sink at zero until their restoration gates pass.
- Preserve original jobs/windows, Strava's 789-ID checkpoint, source R2 archives and the retained rehearsal archive.
- Do not increase deadlines/retries, lower safety guards, sample candidates, skip pathological keys or adopt unreleased ClickHouse patches.
- Current qualification artifacts: ClickHouse 26.10.2.103, Pulsar 5.0.1, Oxia 0.18.0, Debezium 3.7.0.Final and official Node client 1.18.0. Recheck latest stable releases when adding/updating artifacts. The subsequently approved existing-consumer CDC assessment/spike supersedes SeaTunnel as the candidate integration path; it adds no ETL framework. Its [bounded source results and SDK limits](../../owned-cdc-assessment.md#executed-isolated-source-qualification) do not qualify the full sink or host.
- No reduced production ClickHouse ceiling, complete host budget, production quota enablement or whole-stack soak has passed.
- No branch switches/rebases. Prefix shell commands with `rtk`; commit and push each reviewed task. Never merge/deploy documentation just to record progress.
- Scripts are TypeScript run with `pnpm tsx`; use the workspace Compose wrapper. No new scheduler/framework or permanent dual source of truth.
- Real database semantics require executable database tests, not SQL substring assertions. Do not replay historical migrations in test setup.
- New configuration keys must exist in Infisical before production references them; print names only. Unexpected errors use existing Sentry reporting and actionable processing errors.

## Review Focus

1. A source UUID moves twice before projection: former placements must still retract, including an ownership conflict (Tasks 2–4).
2. A marker arrives while one raw write or journal receipt is missing: neither a seal nor processing success may be manufactured (Tasks 1–2, 6).
3. A client disconnect leaves a ClickHouse insert running: a replacement writer cannot publish concurrently or be overwritten later (Task 5).
4. One key has extreme version/provider fanout: it fails visibly within resource boundaries without cursor advancement or partial success (Tasks 3, 5, 8). Task 3 qualifies query-owned memory failure and no published rows; Task 5 case `pathologicalPageMemoryFailureDoesNotCheckpoint` must prove the actual executor does not compare-and-set its cursor.
5. Erasure races a shared journal page/cursor: deleted-account work cannot resurrect, and unrelated-account effects cannot be skipped (Task 7).

## Scope, dependencies and file map

This is the analytics sub-project. It does not authorize retiring PeerDB or
cutting over the transport. Parent-plan Tasks 2–3 supply `MetricStreamPosition`,
the native client and `MetricStreamConsumerBatchContext.positions/assertActive`.
Task 1 below may first qualify positions in the isolated topology; no alternate
production transport adapter or custom CDC service is introduced. Parent Task 1
remains incomplete until this plan's resource gates and the other qualification
gates pass. R2 conversion stays mandatory in parent Task 5.

| Responsibility | Files |
| --- | --- |
| Typed delivery order and structural effect contract | Parent `src/metric-stream/transport-position.ts`; new `src/analytics/effect-journal.ts` |
| Small durable run/frontier/cursor state | New `src/analytics/analytics-work-store.ts`, `src/db/schema/analytics-work.ts`; export from `src/db/drizzle-schema.ts`; generated next Drizzle migration |
| Journal and ID-leading structural placement | New `src/analytics/source-placement.ts`, `src/db/analytics-work-schema.ts`; next ClickHouse migration and `registry.ts` |
| Sink effects before acknowledgment | Existing `src/metric-stream/clickhouse-sink.ts`, `clickhouse-table.ts`, parent native consumer |
| SQL scopes and complete-key transformations | `analytics/macros/analytics_effect_scope.sql`, `analytics/models/staging/sensor_scalar_sample.sql`, `analytics/models/read_models/deduped_sensor.sql`, `activity_sensor_sample.sql`, `analytics/models/sources.yml` |
| Bounded stage execution / server query ownership | New `src/analytics/bounded-analytics.ts`, `analytics-query-owner.ts`; existing `src/db/clickhouse.ts` |
| Coverage and job lifecycle | New `src/processing/analytics-coverage.ts`; existing processing coordinator/store/reconciler/contracts, analytics worker/queue and build scripts |
| Ownership and deletion | Existing `src/account-erasure/clickhouse-erasure.ts`, `postgres-erasure.ts`, staging barrier and `src/jobs/account-erasure-runtime.ts` |
| Storage qualification and deployment checks | New `scripts/check-storage-boundaries.ts`; existing `deploy/pulsar/`, stack/entrypoint/deploy workflow integration and new `docs/analytics-storage-runbook.md` |

New source files get focused colocated unit tests and integration files where
database behavior is involved. Reuse local `test-helpers.ts` for shared fixtures.
Do not move the ignored spike into runtime. Generated migrations use the next
sequence at execution, never the number observed during planning; deployments
contain schema changes only. Regenerate schema diagrams for PostgreSQL changes.

## Shared contracts

Define production-consumed types in `effect-journal.ts` and
`analytics-work-store.ts`; do not create a generic orchestration package.

- `AnalyticsStage = 'scalar' | 'dedup' | 'activity'`.
- `AnalyticsStream = { epoch: string; topic: string; partition: number }`.
- `JournalDeliveryKey = { major: string; minor: string; batch: number }`: lossless decimal integer components of the qualified native delivery order, **not** a packed Kafka offset. Native serialized positions remain alongside it. Never compare base64 IDs or ingestion timestamps as transport order.
- `AnalyticsEffectCursor = { delivery: JournalDeliveryKey; effectOrdinal: string }` within one stream/stage. Ordinals and integer components persist without JavaScript number truncation. Task 1 reserves cursor-only `-1` for an explicit zero-effect receipt; actual effects remain nonnegative.
- `SensorKey = { userId: string; channel: string; recordedAt: string }`; nanosecond timestamp precision is preserved. Activity output identity additionally includes `activityId`.
- `SourcePlacement = { sourceId: string; userId: string; providerId: string; sourceVersion: string; generation: string; key: SensorKey; activityId: string | null; deleted: boolean }`. This contains no measured scalar/vector/point value.
- `AnalyticsEffect = { stream: AnalyticsStream; position: MetricStreamPosition; cursor: AnalyticsEffectCursor; stage: AnalyticsStage; operationId: string | null; sourceId: string; sourceVersion: string; generation: string; before: SourcePlacement | null; after: SourcePlacement | null }`.
- `RequiredAnalyticsFrontier = { operationId: string; datasetKey: ProcessingDatasetKey; stream: AnalyticsStream; position: MetricStreamPosition }`.
- `AnalyticsEffectPage = { effects: readonly AnalyticsEffect[]; next: AnalyticsEffectCursor | null; exhausted: boolean }`; empty-but-not-exhausted is not a success signal.
- `DatasetAnalyticsCoverage = { operationId: string; datasetKey: ProcessingDatasetKey; state: 'pending' | 'complete'; pendingStages: readonly AnalyticsStage[] }`. Missing/malformed evidence throws; it is not `complete` or an empty default.

The native-order adapter is a Task 1 qualification gate. The official Node API
exposes [serialization and string representation](https://github.com/apache/pulsar-client-node/blob/master/index.d.ts),
not a declared numeric Kafka offset or cross-topic comparator. Pin and inspect the
chosen release's implementation before decoding it; real rollover/batch tests
must establish order. If that representation cannot support the contract, stop
before dependent schema/code and bring the evidence back. Do not guess a parser
or add a permanent undocumented fallback.

### Task 1: Durable work store, journal and finite seals

**Files:** Create the effect-journal/work-store/schema files above, their colocated tests, `effect-journal.integration.test.ts`, `analytics-work-store.integration.test.ts`; modify parent transport-position module/tests and schema registries.

**Interfaces:** `appendAnalyticsEffects(client, effects: readonly AnalyticsEffect[]): Promise<void>`; `readAnalyticsEffectPage(client, input: { runId: string; stage: AnalyticsStage; stream: AnalyticsStream; after: AnalyticsEffectCursor | null; limit: number }): Promise<AnalyticsEffectPage>` with composite page client `{clickhouse,database}`; `sealAnalyticsRun(database, input: { runId: string; frontiers: readonly RequiredAnalyticsFrontier[] }): Promise<void>`; `claimAnalyticsRunOwnership(database, input: { runId: string; expectedOwnerId: string | null; ownerId: string }): Promise<void>`; `checkpointAnalyticsPage(database, input: { runId: string; ownerId: string; stage: AnalyticsStage; stream: AnalyticsStream; expected: AnalyticsEffectCursor | null; next: AnalyticsEffectCursor }): Promise<void>`.

Implementation clarification: receipt-first discovery uses one bounded reference
per manifest row and validates the selected effect payloads. A known receipted
delivery with missing effects cannot appear complete. Analytics run ownership is
distinct from the transport ingestion lease; unchanged-cursor handoff must fence
the old analytics owner. Task 5 still supplies actual query/writer termination
and publication fencing. These close Task 1's missing-evidence and ownership
requirements without introducing another scheduler or a timeout-based takeover.

- [x] **Write failing position tests:** `preservesLargeNativeCoordinates`, `ordersBatchedMessagesAcrossLedgerRollover`, `rejectsComparisonAcrossEpochOrPartition`, `rejectsUnknownNativeRepresentation`. Real native messages must round-trip to the original serialized ID; do not test a hand-invented wire format alone.
- [x] **Run the parent position unit/integration tests red.** Missing ordering support must be the failure. Qualify it against the pinned native client/broker before selecting the ClickHouse column encoding.
- [x] **Write failing database tests:** `limitsEffectsBeforeDistinctKeys`, `replaysDuplicateDeliveryWithoutMissingEffects`, `cannotSealPastIncompleteReceipt`, `laterDeliveryCannotEnterAnAlreadySealedPrefix`, `cursorCompareAndSetRejectsStaleOwner`, `emptyFrontierVectorDoesNotCompleteOperation`. Include sparse delivery coordinates; integer holes are not missing messages.
- [x] **Run red:** `rtk proxy pnpm test:integration -- src/analytics/effect-journal.integration.test.ts src/analytics/analytics-work-store.integration.test.ts`.
- [x] **Implement schema and repository interfaces.** Journal order is `(epoch, topic, partition, delivery components, effect ordinal, stage)`, with replay-stable effect identity and explicit account ownership. PostgreSQL stores runs, required frontiers, stream/stage cursors and ownership only; no per-sensor work rows or raw values. Persist the contiguous **processed delivery** frontier only after all effects/receipts for that delivery exist; seals require it to cover every required frontier. Use exclusive ordered consumption per partition and reject out-of-order admission until qualified; never infer coverage from `max(position)`.
- [x] **Run tests green plus a real restart:** seal a finite input, append later delivery, recreate clients, read at most 20 effects and prove cursor/frontier equality persists. Missing journal/schema/config hard-fails.
- [x] **Review and commit/push:** inspect seal completeness, replay identities, bounded query plan and migration/erasure ownership. Do not release the schema until Task 7's ownership migration is included in the release unit.

### Task 2: Source placement and every sink effect before acknowledgment

**Files:** Create `source-placement.ts`, `source-placement.integration.test.ts`; modify `clickhouse-sink.ts`, its unit/integration tests, `clickhouse-table.ts` and parent `pulsar-consumer.integration.test.ts`.

**Interfaces:** `resolveSourcePlacements(client, sourceIds: readonly string[]): Promise<readonly SourcePlacement[]>`; `applyMetricStreamEventsToClickHouse` consumes required typed batch positions from parent Task 3 and Task 1's effect writer. No optional no-journal production path. Preserve the native publisher/consumer interfaces from the parent plan.

Implementation clarification: source UUID identity spans all intake streams.
Serialize structural preparation and raw/effect completion across those streams,
without per-source PostgreSQL rows. Persist complete immutable structural intent
before raw mutation, including the original ingestion tie-breaker for version-zero
rows; publish effects/receipts only after raw success. Preparation and receipt
finalization for large scopes must themselves be paged. A session mutex alone
does not fence a previously dispatched ClickHouse write; use the shared query
ownership prerequisite and Q7's fail-closed recovery contract below.

Implementation audit clarification: normal live/history contenders wait for
cooperative ownership handoff rather than treating contention as a failed sink.
Use native [PostgreSQL advisory-lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS), not a retry/sleep loop.
After a cooperative failure leaves delivery B pending, an already processed
sibling A may be acknowledged only after exact receipt and processed-frontier
verification under a typed read-only owner operation. That operation preserves
B's pending identity/ingestion time, forces read-only queries and cannot clear
intent or publish. Uncertain owner/query state still blocks both paths.

Every steady-state raw writer is in scope. The provider-deletion job currently
appends raw tombstones and changes generation outside the sink; replace that
path with real, generation-aware broker commands consumed under the same owner.
The existing bounded job persists stable page-command identity before publishing
and advances only after its durable receipt; it does not invent a broker
position. Preserve newer generations and require terminal command/prefix evidence
before final deletion acknowledgment. Account erasure already fences the account
before synchronous physical erasure; its redundant unpositioned raw tombstone
append can be removed with real fence/erasure regressions. Task 7 still owns
physical erasure of every new metadata table and remains a release gate.

- [ ] **Write failing tests:** `journalFailureAfterRawWritePreventsAck`, `replayReconstructsIdenticalEffects`, `scopeDeleteAndGenerationTombstonesHaveEffects`, `markerCannotOutrunPriorEffects`, `sourceMovesTwiceBeforeProjectionRetractBothFormerKeys`, `crossOwnerUuidCollisionFails`, `newestVersionOutsideOldKeyIsResolved`. Include failure after each raw/effect/receipt boundary.
- [ ] **Run red:** focused sink/source-placement integration suites and parent native-consumer suite; verify missing journal behavior causes the failures.
- [ ] **Implement structural placement lookup and sink integration.** Use an ID-leading projection/index over canonical source identity/history, preserving global UUID resolution and ownership. Retain enough structural history to recover every former key, even if a later delivery arrives before analytics runs. No second copy of metric values. Require bounded source-ID input; bootstrap by stable keyset traversal, not global distinct discovery.
- [ ] **Journal all write paths:** normal insert, `tombstoneMetricStreamIds`, newer-delete-scope tombstones, provider/scope delete commands and generated generation fences. `flushRows` must complete raw writes, then durable effects/receipt, then marker acknowledgment. Keep replay possible when raw writes succeed but a later stage fails.
- [ ] **Run green and restart each failure point.** Verify exact source versions/ownership, native subscription acknowledgment and query-visible tombstones—not just handler return counts.
- [ ] **Review and commit/push:** inspect all sink mutation paths and identity collisions. Gate any index bootstrap on bounded source traversal and Task 7 erasure protection; do not add a second steady-state writer.

### Task 3: Bounded scalar and dedup SQL with complete candidates

**Files:** Add `analytics/macros/analytics_effect_scope.sql`; modify scalar/dedup models and `sources.yml`; extend `read-model-sql-test-helpers.ts` only for actual macro rendering; extend `src/db/clickhouse-deduped-sensor.integration.test.ts` and `deduped-sensor-read-model.integration.test.ts`.

**Interfaces:** Macro `analytics_effect_scope(stage)` selects the captured run/stream/cursor interval through required dbt vars `analytics_run_id`, `analytics_stream_epoch`, `analytics_topic`, `analytics_partition`, `analytics_effect_after` and `analytics_effect_through`; cursor vars are canonical JSON strings, not SQL interpolation. Its output is finite source IDs/old/new keys. Full candidate refs remain unfiltered by page ingestion time. `bounded-analytics.ts` (Task 5) supplies the vars; there is one canonical scalar/dedup SQL transformation.

- [ ] **Write failing real-engine cases:** `pagedDiscoveryRetainsOlderUnchangedCandidate`, `deletedWinnerExposesProviderFallback`, `allDeletedKeyEmitsTombstone`, `movedIdIsRetractedFromFormerKey`, `invalidRrRetractsEstimatedHeartRate`, `nullableProvenanceSurvivesPagedSelection`, `duplicateEffectsMatchFullStablePayload`. Seed competing reported/estimated and lower-priority candidates outside the page.
- [ ] **Run red:** `rtk proxy pnpm test:integration -- src/db/clickhouse-deduped-sensor.integration.test.ts src/db/deduped-sensor-read-model.integration.test.ts`.
- [ ] **Implement the shared scope macro and complete-ID/key SQL.** Apply the effect limit before local key deduplication. Resolve global latest ID state before excluding moved/deleted candidates, preserve the exact priority tuple and emit formerly occupied empty-key tombstones. Keep the key-first `LIMIT BY` fix. Eliminate the unbounded sensor path from the final canonical build rather than retaining a fallback switch.
- [ ] **Run green on current stable ClickHouse.** Compare all stable output columns with a complete reference at the existing fixture limits: 800,000 versions, 400,000 IDs, 1,000 keys, 20 effects/page and 128 MiB page memory. Force a pathological key over its fixed allowance; assert explicit failure and no cursor advancement. Do not widen the budget for a pass.
- [ ] **Review and commit/push:** semantic equivalence, query plans, actual memory/exception evidence and no truncated candidates. Update analytics README with the canonical scope contract and primary-source citations.

### Task 4: Bounded activity impact and durable downstream effects

**Files:** Modify `activity_sensor_sample.sql`, scope macro and existing dirty-key logic where reused; extend `activity-sensor-sample-read-model.integration.test.ts`, `activity-sensor-sample-append.integration.test.ts`, `activity-sensor-consumers.integration.test.ts`; add `src/analytics/activity-effects.ts` and focused integration tests.

**Interfaces:** `expandActivityEffects(client, input: { runId: string; effects: readonly AnalyticsEffect[]; after: string | null; limit: number }): Promise<{ effects: readonly AnalyticsEffect[]; next: string | null; exhausted: boolean }>` produces bounded structural impact pages. Activity/CDC changes use the same interface; one source key may fan out across several pages.

- [ ] **Write failing cases:** `midnightAndOverlappingWindowsRetainAllAssociations`, `ambientAndMemberSamplesKeepExistingRules`, `activityOnlyWindowOrMembershipChangeRetractsOldAssociation`, `deletedGroupEmitsTombstones`, `fanoutRequiresEveryExpansionPage`, `laterSourceVersionProducesDurableDownstreamEffectsBeforeCheckpoint`.
- [ ] **Run the activity and new impact integration suites red.** Use real dbt model SQL with minimal current-schema fixtures, not historical migration replay.
- [ ] **Implement bounded fanout and complete activity-key reconciliation.** Persist downstream effect identities before upstream cursors move; stage coverage includes all impact subpages. Preserve existing old-sample reconciliation and source-pair validation. A window/membership correction must enumerate prior target keys as well as new matches through a bounded indexed traversal.
- [ ] **Run green:** compare full stable activity payloads across multi-page inputs, replay, deletion and activity-only CDC edits. Later effects remain pending even if they share a processed key. No whole-history scan hidden behind a post-aggregation limit.
- [ ] **Review and commit/push:** activity association semantics, expansion cursor durability and complete closure. This task does not authorize processing success before Task 6.

### Task 5: Serialized executor, query ownership and output-before-cursor recovery

**2026-11-04 implementation decision — scalar checkpoint only:** The scalar
[executor](../../../src/analytics/bounded-analytics.ts) reuses the persisted
`metric-stream-source` owner, native dbt compiler and journal. Typed pending and
completed descriptors live on the existing stage cursor; original membership
and bounds survive attempts. Each new current-state attempt receives a fresh
durable publication revision before dispatch, while raw operation revisions
remain immutable. After tracked output and exact downstream verification, an
attempt-bound completion record allows cursor-only recovery. This avoids
different current payloads sharing one replacement version; see the
[real recovery cases](../../../src/analytics/bounded-analytics.integration.test.ts).

Publication holds the existing sorted per-account shared advisory guards on one
session through the last PostgreSQL fence check, writes and cursor commit.
Account activation releases its transaction locks before its ClickHouse phase
waits for the common owner. Known-terminal failed-page admission can be released
only with positive native evidence for its last registered request; earlier
requests were consumed before successor registration. There is no runtime log
flush, polling or restart-based automatic proof. The
[native terminal event types](https://clickhouse.com/docs/reference/system-tables/query_log)
and [PostgreSQL lock semantics](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
underpin these checks.

**Separate unresolved Task 7 gate:** The 400,000-identifier fixture exposed an
existing account-erasure identifier-capture aggregation requiring 145.97 MiB
under the fixed 128 MiB query allowance. Scalar failure protection and finite
account erasure are separate executable cases. The identifier query and budget
remain unchanged; this fixture result does not establish production memory fit.
Dedup/activity activation, dbt subprocess ownership, owned CDC, external-writer
retirement and combined throughput/host qualification remain incomplete.

The inline generation lookup reads only the generation table and finite captured
page users; it does not depend on the current-raw candidate pipeline. Its exact
user/provider match and missing-generation-zero behavior remain intact. After
this correction, five generation/fence cases and both existing complete-key
resource/reference cases passed at 128 MiB. The full preceding checkpoint run
passed all 14 executor, 48 query-owner, eight work-store and ten user-guard cases;
the two detected resource regressions were then verified again by the focused runs.

**Files:** Create `bounded-analytics.ts`, `analytics-query-owner.ts`, `analytics-model-compiler.ts` and their colocated/unit/real-engine tests; extend `src/db/clickhouse.ts` command options for actual query IDs/cancellation; modify build/local-build scripts and their tests.

**Interfaces:** `runBoundedAnalyticsPage(input: { runId: string; stage: AnalyticsStage; stream: AnalyticsStream; pageSize: number }): Promise<{ progressed: boolean; remaining: boolean }>`; `assertPreviousAnalyticsQueriesTerminal(client, runId: string): Promise<void>`; `compileAnalyticsPageSql(input: { stage: AnalyticsStage; vars: Record<string, string>; artifactDirectory: string }): Promise<string>`. Required clients/work-store/fence dependencies are supplied by the production composition root, not optional test branches.

Q7 A recovery clarification: cooperative handoff requires a quiescent executor
and terminal dispatched queries. An uncertain crash blocks takeover until an
operator verifies the predecessor and its requests have terminated. Query-ID
registration followed by an unsent request is an explicit failure case: absence
from `system.processes`, a released advisory lock, cancellation attempt or lease
expiry is insufficient. No privileged isolation service or boolean proof bypass.
The shared prerequisite may be implemented during Task 2, but the verified
operator recovery procedure and actual termination tests remain release gates.

- [ ] **Write failing recovery cases:** `crashAfterOutputBeforeEffectsReplays`, `crashAfterEffectsBeforeCursorReplays`, `replacementWaitsForServerQueryTermination`, `failedCancellationBlocksTakeover`, `latePredecessorCannotOverwriteNewerOutput`, `sourceRevisionChangeBeforePublicationRemainsDirty`, `pathologicalPageMemoryFailureDoesNotCheckpoint`. The pathological-page case must exercise a real page-query code 241: no checkpoint compare-and-set, no published output, and an explicit visible failure state. Task 3 query/compiler evidence does not prove executor cursor behavior.
- [ ] **Run executor unit and real ClickHouse integration tests red.** Keep a server query alive after disconnect in the fixture; observing a closed client alone must not satisfy termination.
- [ ] **Implement one serialized page owner.** Persist run/attempt query IDs before execution; use the native server process/cancellation evidence before takeover. Allocate monotonic publication revisions durably for serialized attempts, never trust wall-clock `now64` alone. After verifying current source generation and ownership at publication, insert complete output, persist its downstream effects, then compare-and-set the cursor. A stale owner cannot checkpoint or publish after takeover.
- [ ] **Replace sensor-stage execution in `run-analytics-build.ts` with bounded stage draining.** Compile the actual selected model through native `dbt compile` with required page vars, read its `dofek_analytics` manifest node's compiled SQL, then execute `INSERT INTO` its canonical target through the query-owned native client. Compilation failure/missing node/compiled SQL hard-fails; do not implement a production Jinja renderer. This retains dbt SQL ownership while giving each insert an actual tracked query ID. Reuse the existing cycling projection and downstream model order. Local/manual entrypoints use the same path; do not retain a sensor `dbt build` fallback.
- [ ] **Run green with crash/restart at every boundary.** Reproduce the isolated 20-effect replay result with durable production-used repositories; exact stable payload match, zero sealed pending, one later pending. This is process restart evidence; separately qualify power-loss durability in the recovery gate.
- [ ] **Review and commit/push:** actual server termination, ownership, output revision ordering and idempotent partial effects. Do not infer exactly-once physical inserts from convergence.

### Task 6: Causal sensor/CDC coverage and truthful job/cache completion

**Files:** Create `src/processing/analytics-coverage.ts` and tests; modify `analytics-processing.ts`, processing event store/reconciler/contracts and tests, `src/analytics-worker.ts`, `analytics-refresh-queue.ts`, worker/build scripts and their tests.

**Interfaces:** `loadDatasetAnalyticsCoverage(database, pendingDatasets: readonly ProcessingOperationDataset[]): Promise<readonly DatasetAnalyticsCoverage[]>`. Make its result a required `coverage` input to `buildProcessingAnalyticsEvents` and `recordProcessingAnalyticsRun`. Extend the build result with explicit `state: 'pending' | 'complete'`; pending cannot become `lastSuccessfulAt`, cache warming or a successful wait-for-completion result.

- [ ] **Write failing tests:** `dbtPassWithIncompleteCoverageRemainsRunning`, `sensorMarkerCannotSatisfyCdcFrontier`, `missingRequiredMappingOrMarkerFailsExplicitly`, `laterOperationAtSameKeyRemainsPending`, `cacheWaitsForEveryDependentStage`, `continuationPreservesQueueSerializationAndCompletionHandles`.
- [ ] **Run red:** focused processing/build/worker unit tests; processing coordinator/reconciler and `analytics-refresh-queue.integration.test.ts` through the real integration runner.
- [ ] **Implement the required frontier vector and coverage gate.** Reuse existing dataset dependencies and three processing-marker destinations. Canonical PostgreSQL changes must pass capture, sink visibility, journal receipt and all dependent projection stages. A missing required evidence row throws; an existing incomplete frontier reports running. Do not create a synthetic total order across streams.
- [ ] **Use the existing queue for bounded continuation.** Release the current job only with a durable continuation/operation link; never resolve the original `enqueueAnalyticsRefreshAndWait` promise as complete while a continuation remains. Keep native global concurrency one and existing request-during-build semantics. Cache warming and worker last-success update run only on complete coverage.
- [ ] **Qualify native CDC-to-effect evidence, then run green across all 16 source tables and 18 destinations, including three markers.** The parent CDC qualification must demonstrate that the chosen native capture/sink path preserves delivery identity, source versions, ownership and delete/placement information through durable journal receipts before its covered marker can complete. A successful mirror row write alone is insufficient. Include changed source rows while an earlier run is executing, delayed CDC, missed-delete/WAL-loss readiness and stage-impact closure. The user subsequently approved assessing and qualifying the existing application Consumer integration with official clients; its distinct CDC handler must use the same durable coordinator. If that path cannot supply the contract, stop this gate with exact evidence before enabling completion or retiring PeerDB; do not adopt another framework, alter capture or invent a frontier to conceal failure.
- [ ] **Review and commit/push:** internal pending state must preserve existing web/mobile server-owned processing semantics. If visible status/copy changes, add parity fixtures/tests in both clients in this task; no client metric computation.

### Task 7: Erasure ownership and writer barriers for all new state

**Files:** Modify existing ClickHouse/PostgreSQL erasure inventory, staging barrier, account-erasure runtime and integration fixtures; update new schema FK/ownership checks and `docs/account-erasure-runbook.md`.

**Interfaces:** Extend existing ownership and writer-barrier contracts; no parallel erasure coordinator. Journal/placement tables are attributable by `user_id`. Shared run/stream progress references erased work only through verified structural coverage, never by deleting another account's cursor range.

- [ ] **Write failing cases:** `inventoryRejectsUnclassifiedAnalyticsStore`, `eraseBetweenPageReadAndInsertCannotPublish`, `eraseBeforeJournalAppendCannotResurrectWork`, `restartAfterErasureCannotReplayDeletedAccount`, `erasingOneUserDoesNotSkipAnotherUsersSharedPage`, `restoreReconciliationHonorsAnalyticsErasureFence`.
- [ ] **Run red:** existing `clickhouse-erasure.integration.test.ts`, `postgres-erasure.integration.test.ts`, account-erasure work guards plus new executor/placement race fixtures.
- [ ] **Implement ownership classification, FK cascade/preservation policy and actual insert-boundary fencing.** Add every new state store to the real staging writer barrier. Maintain native Pulsar/archive physical expiry requirements from the parent plan; journal erasure is not physical offload erasure.
- [ ] **Run green with erasure at each persistence boundary and isolated restore.** Verify physical removal/retained nonpersonal coverage policy against the existing deadline; no ready status while any required owned copy remains.
- [ ] **Review and commit/push:** schema+erasure changes ship as one release unit. Unknown ownership hard-fails and cannot be allowlisted merely to complete a test.

### Task 8: Physical storage preflight, resource isolation and aggregate qualification

**Files:** Create `scripts/check-storage-boundaries.ts`, its unit tests and `docs/analytics-storage-runbook.md`; modify stack/entrypoint/CI deployment checks only for the final tested steady state. Extend isolated Compose qualification and `docs/pulsar-qualification.md` / `pulsar-cdc-assessment.md`.

**Interfaces:** `StorageBoundaryRequirement = { path: string; mountSource: string; projectId: number; hardBytes: string; requiredUid: number }`; `StorageBoundaryReport = { passed: boolean; failures: readonly string[] }`; `inspectStorageBoundaries(input: { mounts: readonly StorageBoundaryRequirement[]; requiredReserveBytes: string }): Promise<StorageBoundaryReport>` compares observed mount/project IDs, allocated hard limits, effective UID/capabilities and reserve accounting against requirements. Types live with the production-used check. The script exits nonzero before service startup when enforcement is absent.

- [ ] **Write failing preflight tests:** `rejectsMissingProjectOrWrongMount`, `rejectsQuotaBypassCapability`, `rejectsMissingHardLimitOrOvercommittedReserve`. Feed recorded metadata through the parser; do not add unit tests for static YAML.
- [ ] **Run red, then implement read-only native mount/quota/capability inspection.** Qualify the native server-wide ClickHouse temporary-data cap separately; do not mistake the known query-scope defect for a server-cap result. Use current stable unpatched artifacts and preserve exact failing evidence.
- [ ] **Run isolated kernel enforcement integration:** actual service UID hits project hard quota, spills cannot consume host reserve, partial files clean up, restart/remount retains limits, absent mount fails startup. Keep tmpfs proof distinct from ext4 disk/quotas and power-loss recovery. Do not modify the production filesystem in this step.
- [ ] **Run whole-stack bounded load and outage/recovery soak.** Record all service ceilings, Redis historical peak allowance, OS reserve, data/log/merge/backup overlap and actual allocations; R2 failure/slow ClickHouse must produce visible resumable backpressure. Include the hottest tested key and overlapping ingestion/analytics at fixed limits. No lowered service ceiling or numerical quota is accepted from idle usage or the 11 MiB static page result.
- [ ] **Write exact measured allocations and production maintenance procedure.** Separate data filesystem can be unmounted with root/SSH up only after every data-FS user is quiesced; require accessible verified backups, recovery instructions, installed-tool output and maintenance approval before enablement. Do not assume OCI rescue is mandatory or that missing OCI recovery access is harmless. No loop-device fallback is selected.
- [ ] **Review and commit/push:** FAIL the existing-host gate if the combined budget/soak does not fit; stop for direction before any strategy pivot. Production maintenance is a later explicitly reviewed operator action, not an automated plan side effect.

### Task 9: Bootstrap, migration integration and final restoration gates

**Files:** Extend parent `archive-transfer.ts` / converter, bounded analytics bootstrap operator tooling and cutover runbook; update analytics/deployment/current architecture docs and incident baseline. Bootstrap tool is `scripts/bootstrap-analytics-effects.ts`, with focused real-engine tests.

**Interfaces:** `bootstrapAnalyticsEffects(input: { manifestId: string; mode: 'inventory' | 'apply' | 'verify' }): Promise<{ completed: boolean; blockedRanges: number }>` consumes the parent's sealed conversion manifest and verified source ranges. It uses normal effects/reconciliation interfaces, not manufactured native offload objects or a second analytics implementation.

- [ ] **Write failing cases:** `boundedBootstrapResumesAtEveryPage`, `conversionReusesOriginalIdsVersionsAndObjectProvenance`, `missingArchiveOrderingBlocksRange`, `erasureDuringBootstrapCannotResurrect`, `verificationAccountsForEveryManifestRange`.
- [ ] **Run red, then implement keyset bootstrap with exact source/target coverage receipts.** Keep originals. Unknown Kafka offsets are not `firstOffset + lineOrdinal`; unresolved overlap/deletion ordering blocks the range. Do not silently rebuild from an incomplete current-state snapshot or discard missed deletes.
- [ ] **Run green with actual legacy gzip JSONL layout and native Pulsar/R2 readback.** Apply the parent converter/erasure/recovery tests as required; the normalized fixture alone cannot accept migration.
- [ ] **Integrate through the canonical deploy/cutover workflow only after reviewed gates pass.** Replace old unbounded sensor paths and obsolete runtime/config fully; do not retain an incident flag, dual writer, compatibility service or deferred cleanup TODO.
- [ ] **Perform independent served verification after actual histories and strict analytics:** Strava external `11937295869` is mountain and shares the group with RWGPS `0d6ca68b-d8ae-463b-a753-be35d7d3c3c7`; `analytics.activity_summary` serves mountain; elevation activity `c2ae2bed-844d-48de-b013-23300d514883` retains 274 m ascent/descent. Reconcile every provider gap including Wahoo; no partial pass is full completion.
- [ ] **Restore each of the four owned holds explicitly when safe:** provider queues, history sink and analytics queue each need their own capacity/drain/coverage prerequisite. Confirm zero forgotten pause, healthy site and stable resource bounds. Record exact ranges/counts/timings, remaining limitations and retrospective; clean only stopped task-owned disposable artifacts, not archives/volumes/backups. Commit/push documentation and close the dashboard only on full success.

## Execution, review and verification

Suggested critical path: Tasks 1→2→3→4→5→6→7→9. Task 8's isolated storage
qualification can proceed independently of source transformations after its
interfaces are agreed; its aggregate load test waits for Tasks 1–7. Work in
small reviewed changes on this branch, with no deployment of incomplete
cross-store contracts. The user approved Codex subagents: delegate disjoint file
ownership and read-only reviews; root owns integration and all production
actions. Never run competing Docker stress/build workloads on the shared VM.

At each task: demonstrate RED for the named behavior, implement, demonstrate
GREEN, inspect the diff against the approved spec, review correctness/resource
evidence, then commit and push. Failures require the exact command, first fatal
line and causal explanation before a fix; do not turn a qualification failure
into a timeout/retry/config workaround.

Use these focused commands for the named red/green checks (new files initially
fail for the missing behavior). Native Pulsar cases additionally require the
parent plan's isolated topology and real-service test setup; the ordinary runner
must not silently substitute Kafka or skip a missing dependency.

| Task | Focused red/green command |
| --- | --- |
| 1 | `rtk proxy pnpm test:integration -- src/analytics/effect-journal.integration.test.ts src/analytics/analytics-work-store.integration.test.ts src/metric-stream/pulsar-consumer.integration.test.ts` |
| 2 | `rtk proxy pnpm test:integration -- src/analytics/source-placement.integration.test.ts src/metric-stream/clickhouse-sink.integration.test.ts src/metric-stream/pulsar-consumer.integration.test.ts` |
| 3 | `rtk proxy pnpm test:integration -- src/db/clickhouse-deduped-sensor.integration.test.ts src/db/deduped-sensor-read-model.integration.test.ts` |
| 4 | `rtk proxy pnpm test:integration -- src/analytics/activity-effects.integration.test.ts src/db/activity-sensor-sample-read-model.integration.test.ts src/db/activity-sensor-sample-append.integration.test.ts src/db/activity-sensor-consumers.integration.test.ts` |
| 5 | `rtk proxy pnpm test:integration -- src/analytics/bounded-analytics.integration.test.ts src/analytics/analytics-query-owner.integration.test.ts src/analytics/analytics-model-compiler.integration.test.ts` |
| 6 | `rtk proxy pnpm test:integration -- src/processing/analytics-coverage.integration.test.ts src/processing/analytics-processing.integration.test.ts src/processing/processing-reconciler.integration.test.ts src/analytics-refresh-queue.integration.test.ts` |
| 7 | `rtk proxy pnpm test:integration -- src/account-erasure/clickhouse-erasure.integration.test.ts src/account-erasure/postgres-erasure.integration.test.ts src/jobs/account-erasure-work-guard.integration.test.ts src/analytics/bounded-analytics.integration.test.ts` |
| 8 | `rtk proxy pnpm exec vitest run --project unit scripts/check-storage-boundaries.test.ts`; kernel quota/remount/load exercises use separately recorded isolated operator commands and evidence, never the default unit tier |
| 9 | `rtk proxy pnpm test:integration -- scripts/bootstrap-analytics-effects.integration.test.ts src/metric-stream/archive-transfer.integration.test.ts` |

For pure orchestration additions also run their colocated unit tests with
`rtk proxy pnpm exec vitest run --project unit <named-file.test.ts>`. RED must be
the intended missing contract, not a disconnected service or invalid fixture;
GREEN means all named assertions pass without skips, runtime mocks of database
semantics or increased allowances. Each task's final commit step is
`rtk proxy git add <reviewed-paths>`,
`rtk proxy git commit -m '<task-specific conventional subject>'`, then
`rtk proxy git push origin dull-baboon`. Never stage ignored spike material or
credential-bearing artifacts.

Final code verification uses focused unit and database integration tiers, current
stable real services, `rtk proxy pnpm lint`, root/server/web typechecks and any
changed web/mobile interaction tests. Run SQLFluff with the workspace ClickHouse
started as documented. Static config is schema-validated, not unit-tested.
Qualification evidence uses unique run tokens, complete stable-payload digests,
exception records and physical allocated bytes; cumulative spill counters are
not physical peak usage. Stop only task-owned lab services afterward and preserve
named volumes/original archives. Any HTTP development server additionally needs
the required quick tunnel for its full lifetime.

## Planning self-review

- Scope coverage: durable effects/seals (1–2), complete keys/moves (2–4), replay,
  publication/query ownership (5), causal completion/CDC (6), erasure (7), physical
  bounds/host fit (8), bootstrap/conversion/restoration (9).
- Interfaces: the journal, cursor and coverage names above are used consistently;
  every new export has a stated production consumer. Native ordering remains an
  explicit executable prerequisite, not an assumed API.
- Review focus: all five named risks have concrete failing cases in their owning
  tasks. No task treats model PASS alone as processing completion.
- Execution approval: the user reviewed this plan and replied “y”; Q6 A is
  recorded. Production maintenance/cutover still require their own concrete
  review gates.
