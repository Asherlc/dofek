# Provider-generation command checkpoint

Status: **DONE_WITH_CONCERNS — reviewable protocol implementation; full Task2 is incomplete.**
Review source range starts at `3351cef61c8d6228113da0919c2edab1237e79a0`.
Intervening root checkpoint `d2d3a9a73` changes three human documents only; it is
not implementation or verification of this protocol. Source checkpoint:
`e96f6068bac34fe171a4c1fa9b02669b81f89aab`, committed and pushed to
`origin/dull-baboon`. This report follows in a separate audit-only commit.

## Implemented protocol

- The existing event codec/archive/publisher recognizes one strict V1
  `metric_stream_provider_generation_deleted` command. Stable command/deletion
  UUIDs, owner/provider/generation, at most 1000 unique structural UUIDs, fixed
  owner/provider routing, predecessor and terminal marker are required. No
  sensor values or manufactured transport positions enter job data.
- The first saved command is fence-only, including for an empty provider. Its
  actual sink receipt/typed ACK precedes source enumeration. Subsequent bounded
  pages and the empty terminal command use the same publication owner and
  coordinator as source ingestion. Preparation resolves globally current source
  ownership/version in at most 20-ID pages; raw tombstones remain server-side
  INSERT SELECT operations. Every effect retains its old placement and uses the
  next source version. New/current generations and globally moved identities
  survive. The generation fence only advances; the raw source INSERT includes
  the actual generation/account predicates.
- The existing deletion-ACK table has nullable typed command fields plus a
  constraint for new metadata. Migration `0110_provider_deletion_command_ack`
  upgrades legacy tables without discarding their scope ACK rows. There is no
  duplicate acknowledgement store. A typed ACK validates immutable command
  content, operation identity and the exact completed delivery receipt. A
  duplicate on a later actual delivery receives an empty durable disposition,
  preserving the first ACK position and replacement rows.
- Under the global owner, a predecessor must have matching operation identity,
  a complete exact receipt, an earlier position in the same physical stream and
  a nonterminal command ACK. A different successor for an already committed
  predecessor fails closed. Inductively this admits a linear committed prefix,
  not a maximum-offset shortcut.
- A terminal command scans structural history in bounded keyset pages and
  resolves each page globally before accepting completion. A residual current
  old-generation live source blocks it. The driver requires both the terminal
  command ACK and the original deletion ACK with identical canonical position;
  a server failure between those writes is repaired by replay and cannot expose
  completion early.
- A known account fence is checked before predecessor metadata. It produces the
  existing USERLESS empty delivery disposition and frontier/broker admission,
  without generation/control/typed ACK claims. The next unrelated account can
  proceed. Insert-time ACK/account predicates and installed-generation checks
  remain required for the live-account path.
- The same durable BullMQ job persists pending command content before publish.
  Missing ACK uses `moveToDelayed` plus the real `DelayedError` at the existing
  30-second cadence; no per-page jobs or blocking poll loop remain. ACK progress
  saves checkpoint and last committed command together before creating another
  pending command. Resume revalidates committed proof. The worker checks its
  actual Redis lock token and cancellation signal around awaited boundaries.
  Artifacts, analytics enqueue, cache invalidation and operation completion
  follow terminal proof and retain account-erasure guards.

## TDD and verification evidence

All logs below are in this plan workspace. Engine commands use the existing
private runner, one worker, `--retry 0 --bail 1`. No lifecycle, cap, retry, timeout
or production changes were made by this implementer. Root's local query-log
Wide-part candidate remains active during these checks; it is not a general
resource qualification.

| Command/check | Result and evidence |
| --- | --- |
| Initial codec/driver unit RED | `provider-unit-initial-red.log`: unknown command and old direct driver completing rather than deferring. |
| Publisher RED | `provider-publisher-red.log`: required canonical publish method absent. |
| Codec/publisher initial GREEN | `provider-codec-publisher-green.log`: 43/43. |
| Old-checkpoint RED | `provider-legacy-job-red.log`: checkpoint without canonical chain accepted before the boundary fix. |
| Driver/queues GREEN | `provider-driver-green-initial.log`: 14/14; `provider-queues-green.log`: 70/70. |
| Worker RED/GREEN | `provider-worker-red.log`: missing active ownership adapter; `provider-worker-green.log`: targeted ownership/deferral passed. An intermediate mock lacked the real queue cadence constant and was corrected. |
| Initial real-engine RED | `provider-engine-initial-red.log`: command was incorrectly dispatched as a row (undefined source ID). |
| Initial real-engine GREEN | `provider-engine-initial-green3.log`: fence/late old source/new-generation/page/terminal passed; all seven actual delivery receipts and four typed/final ACKs checked. Intermediate SQL alias-shadowing failures and fixture UUID-selector error are retained in initial-green/green2 logs. |
| Terminal ACK boundary RED→GREEN | `provider-terminal-ack-red.log`: driver reader returned proof after terminal command ACK but before original deletion ACK. `provider-terminal-ack-green.log`: actual definitive server rejection plus same-delivery replay passed after separating private command proof from public completion proof. |
| Protocol boundaries | `provider-engine-boundaries.log`: six passed, then fixture count expected string rather than actual numeric zero; one unrun due bail. Covered terminal replay, duplicate/new-position retention, immutable command content, fork rejection, missing predecessor, and residual-source rejection. |
| Cancellation/monotonicity | `provider-engine-paging.log`: both cases passed before the separate 1001-case timeout. Known account fence cancels before a missing predecessor; monotonic generation and globally moved source survive. |
| Forward migration | `provider-ack-migration.log`: 1/1 passed, legacy NULL metadata retained, actual constraint rejects incomplete typed rows, new canonical command then commits. Expected constraint code469 is not a resource failure. |
| Predecessor/recovery | `provider-engine-recovery.log`: mismatched deletion identity passed; missing-receipt fixture initially used another stream and correctly failed earlier at stream comparison. `provider-engine-recovery2.log`: corrected same-stream missing predecessor receipt and actual raw-tombstone server rejection/replay both passed (2/2). |
| Distinct bounded effects/userless proof | `provider-engine-bounds-userless.log`: 2/2 passed, 12.73s, 780 HTTP requests. Actual 41 effects retain structural preimages with exactly `[20,20,1]` journal writes; actual cancelled receipt has `user_id=NULL,is_empty=1`. This does not substitute for the full1001 gate. |
| Final provider checkpoint | `provider-engine-checkpoint.log`: **13 passed, 1 excluded original1001**, 32.26s, 2450 observed HTTP requests, no resource fatal. Filter `^(?!.*structural1001)`. Revalidates all distinct protocol cases after cooperative fixture cleanup was added. |
| Legacy profile GREEN | `provider-legacy-profile-green.log`: **1 passed, 14 skipped**, 21.01s, 1187 HTTP requests. Command uses the same runner with `src/metric-stream/clickhouse-sink.integration.test.ts -t 'does not amplify incoming' --retry 0 --bail 1`. |
| Focused unit composition | `rtk proxy pnpm exec vitest run --project unit src/metric-stream/events.test.ts src/metric-stream/redpanda-producer.test.ts src/jobs/process-provider-data-deletion-job.test.ts src/jobs/provider-data-deletion-dependencies.test.ts src/jobs/queues.test.ts src/jobs/worker-queues.test.ts src/account-erasure/archive-erasure.test.ts`: **205/205**, `provider-units-final.log`. |
| Typecheck | `rtk proxy pnpm typecheck`: **passed**, `provider-typecheck-checkpoint.log`, after the final fixture changes. Earlier logs retain fixture optional-position and query generic errors corrected before passing. |
| Format/lint/diff | `rtk proxy pnpm exec biome check <all27changedTypeScriptfiles>`: **passed**, `provider-biome-checkpoint.log` (27 files, no fixes). `rtk proxy git diff --check`: passed. Earlier warnings for two unused test imports and a final fixture format change were corrected. |

The exact engine invocation pattern is:

```sh
rtk proxy pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/metric-stream/provider-generation-deletion.integration.test.ts -t '<case filter>' --retry 0 --bail 1
```

Filters/logs: `terminalCommandACKCannot` → terminal-ack RED/GREEN;
`knownAccountFence|staleGeneration|structural1001|forwardACKUpgrade` → paging;
`forwardACKUpgrade` → ACK migration;
`predecessorFromDifferent|ACKMetadataWithout|rawTombstoneServer` → recovery;
`ACKMetadataWithout|rawTombstoneServer` → recovery2.

## Open 1001-effect qualification failure

The unchanged `structural1001SourceContinuationAndTwentyEffectWrites` test seeds
1001 actual old-generation live rows, enumerates 1000+1 structural keys and runs
the real canonical page chain with the 20-effect limit. It hit the existing
**30,000ms test deadline**, `provider-engine-paging.log` (2 passed, 1 failed,
6 skipped, 1 unrun due bail; 37.42s suite wall time, 3512 observed HTTP requests).
This is an OPEN performance/functional qualification failure, not a pass or an
accepted smaller fixture. No timeout increase or fixture weakening was applied.
The original case remains executable for the approved post-owner-fix rerun.

Timeout did not cancel the in-flight callback: afterEach dropped isolated
`analytics_work_d0ca2ee3fdad401d99917c56908b7f5a`, and its next query
`84f0b27d-2088-4721-9c49-42c657103baf` received code81 UNKNOWN_DATABASE at
05:21:58.831 UTC. This is secondary cleanup evidence, not the original failure.
Runner exited1 and no test process remained. Root then independently observed
the exact ExceptionBeforeStart, no unmatched logged starts in the bounded
window, no current namespace queries, namespace absent and async insert queue0
(`timeout-fixture-observer.json`). Together these permitted further isolated
test scheduling; process absence alone does not prove production Q7 recovery.

The fixture now uses its own AbortController through the existing
`context.assertActive` contract and tracks actual sink promises. afterEach stops
new request admission, awaits all in-flight promises/owned requests to settle,
then drops the private databases. Unexpected settlement errors fail cleanup.
This is cooperative test cleanup, not production uncertain-executor recovery.
The final13-case run validates this fixture version; the original1001 case has
not been rerun after the fixture fix and remains OPEN with its original30s bound.

## Behavior migration matrix

| Prior behavior | Current executable coverage |
| --- | --- |
| Provider raw-row pagination/download/tombstones | Driver 1001-key unit progression; engine canonical pages/global latest ownership; full1001-effects engine gate OPEN. Direct writer and measured-value download removed. |
| Generation fence and preservation of reimports | Fence ACK before enumeration unit; real late-old insert/new-generation correction; stale command cannot lower fence; moved source retained. |
| Resume after cursor/publication/ACK gaps | Save-before-publish, save-response loss, publish-response loss, ACK-before-cursor failure and missing committed proof unit cases; raw tombstone and terminal ACK engine replay. |
| Completion ordering | Driver terminal proof gates artifacts/analytics/cache/completion; engine terminal residual/receipt/ACK-gap checks; no boolean-only completion. |
| Account-erasure work guards | Driver guards before publication/artifacts/downstream steps, real known-fence userless cancellation. Concurrent post-preparation metadata race remains Task7 barrier gate. |
| Artifact/staged FIT cleanup | Existing dependency test retains actual staged-file deletion isolation; artifact error blocks completion. |
| Progress/error reporting | Driver preserves checked/deleted counters, tolerated progress transport errors call captureException, failed required dependency propagates. |
| Queue continuations | Same-job token/signal/DelayedError tests replace obsolete distinct batch enqueue assertions; all continuation exports/call sites removed. |
| Archive ownership | New command is erased for its owning account and another account's serialized command remains unchanged. |
| Legacy scope non-amplification | Owner query IDs preserved; assertions require nonempty exact QueryFinish ID set, one per captured request, every JoinResultRowCount0 and 32 visible live rows. Focused real-engine GREEN passed. |

Source files changed: event codec/publisher and colocated tests; new
`provider-generation-deletion.ts` plus its integration test; canonical
`source-effects.ts`/`clickhouse-sink.ts`; ACK table builder plus forward0110
migration/registry; undeployed structural-index projection builder;
`effect-journal.ts` receipt count return and read-only resolver type;
same-job driver/dependencies/queues/worker composition and tests/helpers;
archive ownership and tests; shared current-schema integration fixture;
legacy profiling regression. No root-owned human documentation was staged.

## Scope and release concerns

1. **Full Task2 remains incomplete.** Native adapter/actual subscription cursor,
   crash/redelivery and ACK-boundary evidence remain separate root work. No
   exactly-once physical insert guarantee is claimed.
2. **Next mandatory owner correctness fix:** a callback that catches an unknown
   request error can currently attempt another request after `inFlight` clears.
   It must reject before dispatch, preserve the first uncertain query ID/pending
   intent and block replacement. Root requested separate TDD using an actual
   late write. Guarded atomic query registration/roundtrip reduction is a later
   separately reviewed same-protocol change; no optimization was mixed here.
3. The protected source index/projection is wholly undeployed; its initial
   schema correction does not bootstrap historical sources. Task7 must qualify
   complete bootstrap, readiness and erasure coverage for new index/typed ACK
   metadata, including the writer/erasure barrier after preparation. An empty
   index is never evidence that activation is safe.
4. Task9 must inventory old BullMQ checkpoints and perform an explicit audited
   operator redrive preserving original deletionEventId/user/provider/generation
   and old evidence. Prior effects/tombstones need bootstrap coverage. Runtime
   rejects missing chain proof; it never adopts/reset cursors or manufactures
   receipts/positions. Lost-owner ambiguity is not reset authority.
5. Resource/host/pool and throughput qualification remain open. The sink uses
   an existing runtime database instance, not one per delivery. Source owner
   holds a PostgreSQL session while work-store transactions need another;
   per-pool max1 would deadlock. No resource limits were changed.
6. Physical erasure engine coverage remains open: root observed retained
   canonical fixture tables with default old-parts480s versus a45s physical
   reference test, not a proven production erasure bug. No timeout/retention
   policy was altered to make it green.
   The legacy full15-case suite has not been rerun: root's earlier run passed10
   then stopped at the now-fixed profile assertion with4unrun. This checkpoint
   closes that focused profiling failure only, not all remaining legacy gates.
7. No PostgreSQL schema changes occurred in this checkpoint, so its DBML/ERD
   generation requirement is inapplicable. The ClickHouse forward migration was
   executed against a real old-format ACK table. No new dependencies or env vars
   were introduced.

Retrospective: explicit durable command identities made publication and ACK gaps
testable without fabricated offsets. The real terminal-gap test found a proof
boundary that units alone missed. Actual1001-effects testing exposed request
cost and the test-timeout cleanup race. Next work should retain the same fixture,
measure the separately approved owner change and document the private runner's
timeout/cleanup ownership in the testing runbook. Reuse integration-tests-ready,
test-driven-development and verification-before-completion skills for that work.
