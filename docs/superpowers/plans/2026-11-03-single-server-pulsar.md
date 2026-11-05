# Single-server Pulsar Implementation Plan

**November 5 release split:** the user approved a transport-first milestone
with PeerDB and production holds retained. Full archive conversion, account
archives, owned CDC and bounded analytics remain required afterward. Physical
storage and erasure gates remain binding. Use the current
[remaining-work index](../../pulsar-remaining-work.md) for sequencing and status;
the detailed tasks below are not all first-release prerequisites.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute in this conversation without branch switches or rebases. The user subsequently explicitly approved Codex subagents, superseding the original no-agent instruction.

**Goal:** Replace Redpanda with self-hosted Pulsar on the existing server, convert the existing R2 archive, and restore safe historical processing without losing source data or weakening deletion guarantees.

**Architecture:** Native Pulsar broker, BookKeeper and Oxia run as separate services on the existing ARM64 host. R2 holds native offloaded ledgers; the application retains its ClickHouse business logic with native Pulsar transport. Physical storage isolation and bounded client/consumer work protect the website independently of backlog size.

**Tech Stack:** TypeScript/Node 26, official Pulsar Node client, Pulsar/BookKeeper/Oxia, Docker Swarm and workspace Compose, R2 S3 API, ClickHouse, Postgres/Drizzle, Vitest/MSW.

**Spec:** [Approved design](../specs/2026-11-03-single-server-pulsar-design.md). User approved the design, and explicitly required conversion of existing R2 data afterward; the design's archive-conversion section incorporates that clarification.

## Global Constraints

- Existing server only; no additional machines or managed messaging service.
- No zero-RPO disk-loss claim: one local bookie cannot provide it before offload.
- No branch switches/rebases; Codex subagents are explicitly approved. Prefix shell commands with `rtk` and push every commit.
- Keep production's four owned holds until the relevant restoration gate passes.
- Preserve original provider jobs/windows and Strava's 789 completed IDs; no fresh full-history request.
- Never evict unconsumed backlog, skip corrupt source data, inflate timeouts/retries, or lower safety guards.
- Use stable, version/digest-pinned ARM64 components; verify latest compatible releases when implementing. Pulsar 5.0.1 is the design's candidate, not permission to ignore newer stable releases.
- Repository scripts are TypeScript run with `pnpm tsx`; Compose runs through `pnpm compose --`.
- R2 compatibility, host resource fit, native client build, physical isolation, restore and erasure are gates, not assumed capabilities.
- Verify new environment key names in Infisical before referencing them in production configuration; never print credentials or health-data payloads.
- Preserve source archives throughout conversion; do not manufacture Pulsar offload files.
- Production runtime has one canonical transport after cutover; no permanent dual writers, compatibility broker, or alternate sink framework.

## Review Focus

1. Interleaved archive offset ranges and changed objects must not create fabricated ordering or silently missing events (Task 5).
2. Account erasure racing conversion must not resurrect a deleted account or leave its converted offload copies untracked (Tasks 4–5).
3. Crash after broker/ClickHouse acceptance but before checkpoint/ack must replay safely without premature processing completion (Tasks 2–3, 5).
4. R2 outage plus a stopped ClickHouse consumer must stop intake within physical storage limits, not merely within a logical backlog quota (Tasks 1, 6).
5. Recovering metadata without the matching ledger/offload boundary must fail explicitly rather than claim a successful restore (Tasks 1, 6).

## File and interface map

| Area | Paths and responsibility |
|---|---|
| Qualification | `docs/pulsar-qualification.md`: artifact versions, measured resource/storage budgets, recovery and R2 evidence; `docker-compose.pulsar.yml`: isolated test topology. |
| Transport | `src/metric-stream/publisher.ts`: existing publisher contract moved out of Kafka module; `pulsar-producer.ts`, `pulsar-consumer.ts`, `pulsar-quarantine.ts`: native transport implementations; `transport-position.ts`: typed durable positions. |
| Sink/evidence | Existing `clickhouse-sink.ts`, `clickhouse-table.ts`, `src/processing/metric-stream-processing-publisher.ts`, `src/processing/processing-reconciler.ts`: existing domain behavior and processing evidence. |
| Erasure | `src/account-erasure/pulsar-drain.ts`, `pulsar-retention.ts`: subscription and physical-expiry proofs; existing `archive-erasure.ts`: old JSONL erasure remains functional. |
| Conversion | `src/metric-stream/archive-reader.ts`, `archive-transfer.ts`: validated bounded archive reads and restartable transfer; `src/db/schema/metric-stream-transfer.ts`: structural transfer ledger; `scripts/convert-metric-stream-archive.ts`: operator entrypoint. |
| Deployment | `deploy/pulsar/`, `deploy/stack.yml`, `deploy/stack.oracle.yml`, `deploy/storage.tf`, CI deployment workflow/templates, `Dockerfile`, `entrypoint.sh`, `src/index.ts`: pinned services, secrets and canonical startup/deploy integration. |
| Verification/docs | Colocated `*.test.ts` and real-service `*.integration.test.ts`; `docs/pulsar-cutover-runbook.md`, current architecture docs and incident baseline. |

New directories receive README/AGENTS and matching CLAUDE/GEMINI symlinks when required by repository policy. Generated Drizzle/ClickHouse migration filenames must use the next available sequence at execution time, never overwrite an existing journal entry. Every task reads the parent/local instructions before editing.

## Task 1: Qualify the topology and prove physical/resource feasibility

**Approved follow-up:** The existing-host budget and historical analytics work
remain unqualified. The user approved the [bounded analytics amendment](../specs/2026-11-03-bounded-analytics-design.md);
its [implementation plan](2026-11-03-bounded-analytics.md) expands analytics
qualification and causal-completion requirements here and in Task 3. Isolated
transport-position/consumer-contract work needed by that qualification may be
developed before the aggregate budget passes; this does not pass Task 1 or admit
production deployment. Keep all resource, erasure, recovery and cutover gates.

**Files:** Create `docker-compose.pulsar.yml`, `docs/pulsar-qualification.md`; modify workspace Compose/test integration only where needed to run the isolated topology.

**Interfaces:** Produces an evidence record containing exact image/client versions and digests, ARM64/native-client results, complete host resource accounting, storage enforcement procedure, R2 test-object scope, measured recovery boundary and explicit PASS/FAIL per gate. Later tasks consume the reviewed record; an absent result is not PASS.

- [ ] Inventory the current host read-only: all service limits, data/root usage, filesystem features/mount options, retained backlog/archive boundaries, and the four holds. Record timestamped evidence without secrets or event payloads.
- [ ] Resolve latest stable compatible releases and inspect ARM64 manifests. Test the official client in the actual Node 26/Alpine image; if the documented native build needs a different base, assess that change explicitly before adopting it.
- [ ] Build the isolated one-broker/one-bookie/one-Oxia topology with quorum 1 and separate metadata namespaces. Start only with `rtk proxy pnpm compose -- -f docker-compose.yml -f docker-compose.pulsar.yml --profile pulsar up -d --wait` after the overlay defines that profile. No production R2 access is used by default.
- [ ] Exercise publish/read/ack, offload/readback after local GC, interrupted upload, process restarts, R2 denial, disk exhaustion and matched/mismatched metadata restore. Use synthetic fixture IDs and record counts/digests; validate actual R2 in a separately scoped test bucket after credential/provisioning prerequisites pass.
- [ ] Calculate aggregate memory ceilings plus host reserve and peak disk/compaction overlap. Test native ext4 directory-budget enforcement in an isolated filesystem before proposing production enablement. Do not enable features or remount production during qualification.
- [ ] Record exact safe configuration values and reproducible commands from measurements. If resource fit, physical isolation, full restore or R2 support fails, stop and report that gate; do not pivot or buy capacity. Review the results before Task 2.
- [ ] Commit and push qualification files. Check Compose schema/rendering; do not add unit tests for declarative YAML. Source: [Apache deployment](https://pulsar.apache.org/docs/5.0.x/deploy-docker/), [BookKeeper disk controls](https://bookkeeper.apache.org/docs/reference/config/).

## Task 2: Native producer and durable transport positions

**Files:** Create `publisher.ts`, `transport-position.ts`, `pulsar-producer.ts` and colocated tests; modify existing `redpanda-producer.ts`, `events.ts`, `write-metric-stream.ts`, processing publisher and their production callers; add tracked marker migrations when Task 3 consumes positions.

**Interfaces:** Move `MetricStreamEventPublisher`, `MetricStreamPublishOptions`, `MetricStreamReplacementPublishResult` unchanged to `publisher.ts`. Define `MetricStreamPosition = { transport: 'kafka'; epoch: string; topic: string; partition: number; offset: string } | { transport: 'pulsar'; epoch: string; topic: string; messageId: string }` in `transport-position.ts`; `messageId` is the official client's serialized ID encoded as base64, not a derived integer. `PulsarMetricStreamEventPublisher` implements the existing publisher contract; `getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher>` moves to the canonical publisher module at cutover.

Define the production-used lower-level `MetricStreamEventSender.sendEvents(messages: readonly { payload: Buffer; partitionKey: string }[]): Promise<readonly MetricStreamPosition[]>`. Both the publisher and archive converter use it. The converter sends validated original JSON bytes through this interface; it must not call `publishRows`, which creates fresh envelopes. Rename the existing event union to `MetricStreamEvent` throughout runtime/tests rather than preserving a permanent Redpanda-named alias.

- [ ] Write failing `pulsar-producer.test.ts` cases for partial send failure, finite pending sends, byte-bound batches, delete-before-replacement ordering, stable operation revisions, and no processing-completion marker after a failed send. Test position round-trips with IDs beyond safe JS integer range.
- [ ] Run `rtk proxy pnpm exec vitest run --project unit src/metric-stream/pulsar-producer.test.ts src/metric-stream/transport-position.test.ts`; confirm failures arise from the missing behavior.
- [ ] Implement using the official client and Task 1's measured limits. Preserve existing event payload IDs/versions and await acceptance; propagate backpressure errors to the existing resumable job path. Never regenerate a replacement revision on retry.
- [ ] Add real Pulsar integration cases for restart/resend and interrupted producer acknowledgment. Assert semantic event identity, ordering per key and explicit failure; do not assert physical exactly-once delivery.
- [ ] Run focused unit/integration tiers, root/server/web types, then review the transport contract. Commit and push. Production selection remains unchanged until Task 7.

## Task 3: Bounded consumer and processing evidence

**Files:** Create `pulsar-consumer.ts`, `pulsar-quarantine.ts` and tests; modify existing `clickhouse-sink.ts`, `clickhouse-table.ts`, processing reconciler, readiness and related integration tests; add forward-only ClickHouse marker-schema migration.

**Interfaces:** Replace `MetricStreamConsumerBatchContext.eventOffsets` with `positions: readonly MetricStreamPosition[]`; topic remains explicit. Replace its Kafka-only `heartbeat()` with `assertActive(): Promise<void>`, implemented by real consumer connectivity/cancellation checks for Pulsar and heartbeat/ownership checks while Kafka remains in migration. `runPulsarMetricStreamEventConsumer(options): Promise<void>` consumes a configured durable subscription and invokes the existing `applyMetricStreamEventsToClickHouse` handler. No broker implementation exposes a fake heartbeat/offset. Persist position kind/epoch plus the native position in marker evidence; retain the meaning of historical Kafka rows during migration.

- [ ] Write failing tests: handler rejection does not ack; insert succeeds/ack fails then replay preserves query-visible rows; quarantine failure does not ack; receiver/batch bytes and concurrency stay within Task 1 limits; late completion marker cannot report ready before expected rows exist.
- [ ] Run focused tests red; implement bounded prefetch, serialized handler calls and acknowledgment after sink evidence. Keep delete fences, provider generations and tombstone semantics in the existing handler.
- [ ] Execute real ClickHouse/Pulsar tests for restart at each insert/marker/ack boundary, out-of-order marker arrival and old/new transport evidence coexisting. Update the current real processing-reconciler fixture rather than relying on SQL substring tests.
- [ ] Verify actual subscription drain and failure readiness, not merely process liveness. Add actionable server errors and Sentry capture for unexpected failures.
- [ ] Run focused tiers and type checks; review that no Kafka-position arithmetic is applied to Pulsar IDs. Commit and push.

## Task 4: Erasure and physical retention proofs

**Files:** Create `pulsar-drain.ts`, `pulsar-retention.ts` and corresponding tests; modify existing account-erasure orchestration, retention and restore reconciliation; preserve `archive-erasure.ts` for existing JSONL objects.

**Interfaces:** `capturePulsarDrainBoundary(): Promise<PulsarDrainBoundary>` returns topic/subscription/epoch and native boundary IDs. `assertPulsarDrainComplete(boundary): Promise<void>` proves durable processing to that boundary. `assertPulsarReplayExpired(boundary): Promise<void>` separately proves local/offloaded/quarantine/backup expiry; neither function infers physical erasure from acknowledgment alone. Boundary types live with the drain implementation and serialize into the existing erasure ledger.

- [ ] Write failing real-service cases for deletion during replay/offload, disconnected subscriptions retaining shared ledgers, account deletion during archive conversion, and restoring a pre-deletion backup. Expected result: immediate write fencing, no resurrection and no completed-erasure status while physical copies remain.
- [ ] Run red, then implement with native admin/retention APIs and existing account-fence coordination. No TTL that discards required unprocessed records; no direct deletion of shared offload objects underneath BookKeeper.
- [ ] Verify existing legacy JSONL rewrite/verification still works alongside new native-ledger expiry. Measure the complete expiry bound against the application's existing erasure deadline.
- [ ] If shared-ledger retention cannot meet the deadline while preserving required backlog, stop before cutover and report the incompatible requirements. Do not silently weaken either guarantee.
- [ ] Run account-erasure and processing integration suites; review restore and expiry evidence, commit and push. Source: [Pulsar retention semantics](https://pulsar.apache.org/docs/4.0.x/cookbooks-retention-expiry/) and [offload lifecycle](https://pulsar.apache.org/docs/next/tiered-storage-overview/).

## Task 5: Convert all existing R2 archives into native Pulsar storage

**Files:** Create `archive-reader.ts`, `archive-transfer.ts`, their unit/integration tests, `src/db/schema/metric-stream-transfer.ts`, its generated tracked migration, and `scripts/convert-metric-stream-archive.ts`; extend existing `r2-replay.ts` only for shared key validation. Update `scripts/README.md` and the cutover runbook.

**Interfaces:** `readMetricStreamArchiveObject(input): AsyncIterable<ArchivedMetricStreamEvent>` yields validated original payload bytes with `{objectKey, objectVersion, lineOrdinal, payloadSha256}` provenance. Object version uses observed ETag plus content digest; do not assume ETag is a cryptographic hash. `transferMetricStreamArchive(input): Promise<ArchiveTransferResult>` consumes a sealed manifest and the Task 2 `MetricStreamEventSender`, persists accepted progress in a structural Postgres ledger, and returns counts of inventoried/verified/blocked/reconciled-erased objects. It never stores duplicate raw event payloads in Postgres. The script supports `inventory`, `transfer`, `verify` and requires explicit execution mode for writes.

- [ ] Write failing reader tests for gzip/truncated streams, invalid event versions, large objects with bounded streaming memory, delete events without `recordedAt`, malformed keys, overlapping ranges and per-line provenance. Preserve original event IDs, versions and processing fields exactly. The current archive format has only filename offset ranges; never synthesize individual offsets as `firstOffset + lineOrdinal`.
- [ ] Add failing transfer tests for interruption before send, after acceptance/before checkpoint, checkpoint resume, changed ETag/content, duplicate source objects, missing source object, source rewritten by erasure, account deletion during publishing and concurrent execution of the same manifest. Verify no completion after unresolved discrepancies.
- [ ] Run red; implement paginated inventory and streaming gzip/JSONL validation. Seal manifest membership and destination mapping. Keep all source originals. Use one durable ownership lease per manifest; expired ownership must fence a stale transfer process before it sends again.
- [ ] Implement bounded publish through Pulsar, preserving per-object line order and deterministic source-partition mapping. Store source object/line provenance as message properties, not new application raw-data columns. Overlap ranges are reconciled by event identity/version and tested delete/marker semantics; exact-order requirements unsupported by archived metadata are blocked or recovered from retained Kafka, not guessed.
- [ ] Persist accepted checkpoints after broker acceptance. A lost response may cause a duplicate physical delivery; verify semantic idempotence and do not label this physical exactly-once conversion. Apply Task 4's erasure fence before publishing and account for source changes without reintroducing erased events.
- [ ] Execute integration fixtures using the actual gzip JSONL layout produced by `deploy/redpanda/metric-stream-r2-archive.connect.yml`, real S3-compatible storage, Postgres, Pulsar and ClickHouse. Assert original payload readback, tombstone behavior, expected distinct rows and incomplete-marker behavior across overlaps.
- [ ] Verify native offload completion, local ledger GC, broker restart and destination readback digest/counts for each completed fixture. Keep a verification subscription/retention policy until this proof passes; acknowledged messages must not disappear before they can be offloaded and verified.
- [ ] Define completion as every inventoried object verified or explicitly reconciled as erased/changed. Record all blocked gaps. Run source missing/permission denied tests and ensure nonzero exit without source deletion. Review converter correctness before any production archive writes; commit and push.

The transfer is migration tooling, not a permanent dual archive writer. Old JSONL remains readable by the maintained reader and erasable by its existing owner; native Pulsar storage is produced exclusively through broker APIs. This is the required backward-compatibility path, not binary compatibility between the two R2 formats.

## Task 6: Production configuration, resource enforcement and recovery evidence

**Files:** Create `deploy/pulsar/` component/policy configuration and `docs/pulsar-cutover-runbook.md`; modify stack/Oracle override, `deploy/storage.tf`, CI secret templates, deployment readiness checks, application image and test service setup.

**Interfaces:** Consume exact tested versions, component budgets, storage limits and policy values from Task 1. Runtime configuration has explicit required endpoint/auth/topic/subscription/epoch keys. A missing key fails startup with its name; no Kafka fallback. The canonical deploy workflow owns initialization and restores only services whose current operation gate permits it.

- [ ] Provision the isolated R2 offload bucket through Terraform with reviewed existing state and cost; verify least-privilege credentials in Infisical by key name. Do not use missing OCI state as justification for a blank apply. Existing source archive bucket is unchanged.
- [ ] Implement reviewed host storage enforcement through tracked infrastructure configuration only after its mount/feature prerequisites and maintenance impact are resolved. Set native BookKeeper disk controls and measured namespace/client/dispatch limits; no invented defaults.
- [ ] Validate rendered Compose/Swarm configuration and actual resource ceilings. Do not add tests asserting static YAML strings. Add behavioral deployment/readiness tests only for executable initialization and boundary checks.
- [ ] Perform an isolated ARM64 soak with synthetic production-shaped events and ClickHouse peak work: stop ClickHouse, deny R2, fill the bookie budget, crash each component, restore matched and mismatched backups. Assert bounded RSS/disk, healthy web-class workload and explicit producer rejection without acknowledgment loss under process restarts.
- [ ] Demonstrate single-server disk-loss restore separately, report the measured loss window, and fail any claim that the offload bucket alone reconstructs missing metadata. Retain reproducible restore commands and evidence with timestamps.
- [ ] Review evidence from Tasks 1–6. If any acceptance gate fails, stop production cutover. Commit and push the steady-state configuration only when it represents the reviewed intended state; no incident-only flags or bypasses.

## Task 7: Sealed cutover, complete archive conversion and incident recovery

**Files:** Update cutover runbook, current architecture/deployment docs, processing-status and account-erasure runbooks; update `docs/production-incident-baseline.md`. Remove obsolete Kafka runtime files/config only after the verified retirement boundary.

**Interfaces:** Consume a sealed source inventory (all R2 objects plus retained Kafka ranges), verified destination mapping, Task 5 transfer ledger, and a signed-off operational evidence record from Task 6. Output is a reconciled cutover report, explicit source-retirement decision and four-hold restoration ledger.

- [ ] Reestablish safety monitoring; inspect live release/deployment state, source counts/ranges, archive coverage and each hold. Quiesce all affected writers through the supported deployment path. Preserve existing provider windows and checkpoints verbatim.
- [ ] Prove temporary overlap capacity for both brokers and bounded converter work. If there is insufficient space for overlap, do not start both; return the blocked migration gate for review. Do not delete the source backlog to make room.
- [ ] Inventory all existing archive objects and seal the manifest. Transfer and verify all archived events, not merely the currently unconsumed Kafka tail. Add retained unarchived Kafka ranges through the exact sealed source boundary. Track coverage separately from semantic deduplication; unexplained gaps cannot pass.
- [ ] Deploy the single Pulsar producer/consumer path through canonical CI after tracked schema changes. No dual-write interval. Verify active source/image, current topics/subscriptions, public health and server-owned processing evidence.
- [ ] Resume bounded history consumption only after physical capacity and archive conversion are verified. Restore the paused Ride with GPS and Strava queues when safe; restore analytics only after required history drain. Record each of the four hold transitions and verify no forgotten hold remains.
- [ ] Complete all remaining provider histories, retaining Wahoo's 16 upstream gaps as unfinished until resolved. Run normal strict analytics refresh without increasing the four-minute query deadline; diagnose any repeated failure using real ClickHouse regression tests.
- [ ] Independently verify the target MTB activity/group/modality and repaired 274 m ascent/descent, plus site health and processing completion. Report partial outcomes truthfully if provider upstream gaps remain.
- [ ] Retire Redpanda runtime/config, its direct consumers and obsolete Kafka dependencies only after all relevant range, retention, erasure, migration and rollback obligations pass. Preserve historical audit evidence and required source archives. Original R2 deletion is a separate reviewed lifecycle action, never a converter side effect.
- [ ] Run `rtk proxy pnpm test:changed:all`, lint and root/server/web types; perform applicable web/mobile parity checks if visible behavior changed. Inspect CI results before release. Commit and push docs/code, update dashboard and record a concise incident retrospective with remaining risks.

## Verification and review cadence

For each executable behavior, write the failing focused test, confirm its failure,
implement the minimum sound change, then run the focused test green. Unit tests
use `rtk proxy pnpm exec vitest run --project unit <files>`; real-service tests use
`rtk proxy pnpm test:integration -- <files>` after confirming the runner's argument
contract in `scripts/run-tests.ts`. Use MSW for third-party network fixtures, not
module mocks in integration tests. Static config uses schema/render validation.

Every task ends with a self-review against the spec, the task's failure cases,
relevant checks, and a pushed commit. Execution remains in this session without
subagents. No production cutover or safety-hold restoration occurs merely because
local tests pass. Task 6 supplies the separate production-readiness evidence.

## Self-review record

Spec coverage maps topology/resources to Tasks 1/6, native transport and evidence
to Tasks 2/3, deletion/restore to Tasks 4/6, all existing R2 conversion to Task 5,
and sealed cutover/provider recovery to Task 7. Each Review Focus item has named
tests in its owning task. Legacy Kafka coordinates, archive provenance and new
Pulsar message IDs remain distinct. No unsupported promise of recovered individual
Kafka offsets, R2 certification, bounded shared disk or zero-RPO recovery is made.
Production values remain evidence-dependent gates rather than guessed numbers.
