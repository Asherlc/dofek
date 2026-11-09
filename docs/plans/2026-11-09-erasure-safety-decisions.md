# Erasure safety decision package

Status: proposed implementation direction, awaiting approval. This document
resolves the choices in the [six retained review threads](https://github.com/Asherlc/dofek/pull/3234#discussion_r4507302091);
it does not assert that their fixes exist or authorize a production action.
Reviewed against erasure head `1f0cdddb5` containing main `6fe1d4fbd`.
The later main synchronization includes [PR3237](https://github.com/Asherlc/dofek/pull/3237)
at `d4e7a34e4`; its shared quarantine validation does not change these proposed
writer, recovery or key decisions.

## Recommended decisions

| Decision | Selected approach | Cost or limitation |
|---|---|---|
| Publication race and production qualification | Reuse the existing durable publication owner for actual sink, analytics and erasure callers. Require real entrypoint concurrency tests. | One shared resource serializes publication; a long analytics build delays sink batches and erasure. |
| Physical admission recovery | Replay only the exact frozen DELETE after the existing owner can safely admit a replacement executor. Preserve the original parts, schema binding and mutation evidence. | An abandoned or uncertain owner stays blocked; there is no automatic crash clearance. |
| Legacy route-less checkpoints | Block migration 0179 while any request is unfinished; drain with its original worker first. | Release must wait for drain. Do not reconstruct missing routes or offsets. |
| Credential master-key changes | Drain retained erasure state before rotation, and bind retained identifiers to their original key configuration so a mismatch fails before lookup or progress changes. | Rotation during an unfinished erasure is unsupported; restoring the original key is required to resume it. |

The existing [publication-race diagnostic](../evidence/erasure-extraction-20261108/README.md#proven-publication-race)
demonstrates the check-to-write gap. An additional PostgreSQL lock alone is
insufficient: [session locks end with their session](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS),
while [ClickHouse HTTP requests can continue after a connection is lost](https://clickhouse.com/docs/interfaces/http#using-clickhouse-sessions-in-the-http-protocol).
Building a second coordinator or a query-history recovery framework would add
more maintained machinery without resolving that uncertainty by itself.

## Exact publication boundary

Use `ANALYTICS_PUBLICATION_RESOURCE` and
[`withAnalyticsQueryOwner`](../../src/analytics/analytics-query-owner.ts).
Keep its durable non-quiescent owner, serial query registration and consumed
terminal-response rules. No new owner table, lease takeover timer, receipt
protocol, transport acknowledgement or remote-query inventory is proposed.

1. In [`runMetricStreamClickHouseSinkFromEnv`](../../src/metric-stream/clickhouse-sink.ts),
   the actual `handleEvents` callback acquires ownership before invoking
   `applyMetricStreamEventsToClickHouse`. Supply the owned client throughout
   fence reads, inserts, tombstones and existing processing-marker writes.
   Await terminal responses before returning to the consumer. Retain heartbeat
   activity during ownership contention; offsets must not advance while blocked.
   A replacement consumer must acquire the same resource before publishing.
2. In [`runAnalyticsBuildFromEnvironment`](../../scripts/run-analytics-build.ts),
   hold that owner across input dbt builds, the cycling projector and downstream
   dbt builds. Pass the owned client to the projector. Its exported publication
   API must require an owned client; adapt actual callers rather than adding a
   raw-client fallback or nesting the same lock. Two additional real writer
   entrypoints require the same admission/child boundary:
   [`runLocalAnalyticsBuild`](../../scripts/run-local-analytics-build.ts) and
   [`runActivityIntegrityDbtBuild`](../../src/db/activity-data-integrity-dbt.ts),
   used by both bounded repair paths in
   [`activity-data-integrity-repair.ts`](../../src/db/activity-data-integrity-repair.ts).
   Preserve their model selections, bounds and isolated artifacts; sharing
   publication ownership does not mean replacing them with an unbounded build.
3. Extend the existing owner only enough to register a dbt child as non-terminal
   **before spawn**. Retain `query_terminal=false` durably until the pinned
   adapter's synchronous success has been qualified and the child closes
   successfully. Child errors, signals, missing/failed artifacts, parent death,
   lost PG session or uncertain response leave the resource blocked. A synthetic
   child identifier must never be presented as proof that a ClickHouse query
   terminated. Stock cancellation may assist diagnosis; it does not auto-clear
   this owner.
4. Use the adapter's stock profile `custom_settings` for synchronous inserts,
   buffered command responses and mutation completion. Verify the actual pinned
   adapter consumes those responses and does not override them. Do not treat
   child exit zero alone as proof before this qualification passes. ClickHouse
   recommends [profile settings over SET pre-hooks](https://clickhouse.com/docs/integrations/dbt/features-and-configurations#set-statement-warning),
   and documents [HTTP completion caveats](https://clickhouse.com/docs/interfaces/http#http-response-codes-caveats)
   and [`mutations_sync`](https://clickhouse.com/docs/operations/settings/settings#mutations_sync).
5. Erasure preparation, fence publication, physical application and verification
   in the [runtime](../../src/jobs/account-erasure-runtime.ts) use that same
   resource. Reacquisition between phases is safe only when intervening writers
   recheck the established account fence inside their owned publication boundary.
   Keep the existing request lease and bounded retained-identifier store.

The repository build script and worker must be the canonical writable analytics
entrypoints. Audit other checked-in dbt/projector invocations and route writable
ones through the same entrypoint. An arbitrary privileged SQL client cannot be
made cooperative by this application lock; direct writable dbt/SQL operation
outside the boundary must remain an explicitly excluded operational action.
If the actual caller audit finds a normal writer that cannot use this boundary,
implementation must stop at that concrete gap rather than claim complete coverage.

## Recovery, cutover and key changes

### Physical admission

[`executeClickHousePhysicalErasure`](../../src/account-erasure/clickhouse-physical-erasure.ts)
already retains the frozen predicate, target parts and admission before dispatch.
When admitted work lacks native mutation evidence, do not mark it complete or
clear its plan. A replacement admitted by the durable owner may rerun only that
same predicate with synchronous mutation completion, then retain all old and new
lineage and repeat physical proof. Owner admission remains a prerequisite;
absence from `system.processes`, a timeout or an unlocked PG advisory lock cannot
substitute for it. A crash leaving a non-quiescent owner does not permit this
automatic replay. Verified recovery of such an owner remains a separate operator
procedure, not a new automatic recovery implementation.

### Legacy cutover

Extend the existing [0179 guard](../../drizzle/0179_account_erasure_identifiers.sql)
to reject `status <> 'completed'`, including scrubbed requests whose route-less
checkpoint cannot satisfy the new schema. Keep its table lock and existing
requirement to quiesce original producers/workers through cutover. Do not rewrite
legacy checkpoint JSON. Completion of old requests is a future release action;
this work authorizes no production drain, pause or migration.

### Key binding

The existing [credential contract](../credential-encryption.md) already requires
a data migration for changing keyring configuration. Retained identity hashes,
cursors and physical seals additionally depend on the master key; re-encrypting
ciphertext alone is insufficient.

Persist a request-scoped key-configuration binding with the existing PostgreSQL
identifier-capture checkpoint, in the same transaction as initial identifier
capture. Derive it using the existing credential identifier primitive, with a
distinct fixed purpose/context that includes the resolved key namespace/name
(those two values are not part of the primitive's current derivation). Check it in retained-state access and capture
reentry before deriving lookup keys or advancing progress; missing or mismatched
binding must fail closed even for an empty lookup. Remove it through normal PII
scrub. No key bytes, new secret, second keyring or in-place re-key is introduced.

The release/rotation runbook must require a stable old key until all identifying
requests and retained identifiers have drained, with original producers/workers
quiesced across the key transition. The binding is the runtime protection against
mixed-key workers or a new request racing that operational transition: it rejects
access under a different key rather than silently interpreting a lookup miss as
absence. It does not claim a distributed atomic rotation of Infisical secrets.

## Acceptance and release gates

Run each failing regression before its fix, using real PostgreSQL/ClickHouse
where database behavior matters. Add focused tests to existing suites:

- Actual sink `handleEvents`: delayed admission/fence/read/insert and consumer
  replacement; the erased account cannot reappear, unrelated rows survive, and
  offsets/processing acknowledgement do not advance before owned completion.
- Actual analytics entrypoint: delayed dbt insert and cycling publication versus
  erasure, successful terminal completion, abnormal child exit, parent termination
  and PG session loss with a remote request outstanding. Unknown completion
  remains blocked across a new executor. Prove the pinned adapter's settings and
  response handling against the real engine.
- Local builds and bounded integrity repairs: the actual production functions
  wait on the same owner before spawning a child; abnormal completion retains
  the barrier. Preserve bounded model scope and repair verification.
- Physical replay: admission-before-dispatch failure with a qualified terminal
  owner, completed response loss, still-running ambiguous mutation, retained
  inactive/projection parts and frozen-schema mismatch. Never discard previously
  captured part names when issuing a second native mutation.
- Migration: scrubbed unfinished and identifying unfinished requests both block;
  only completed, scrubbed legacy state permits the guarded schema transition.
- Keys: a changed master key, namespace or name rejects retained lookup and
  progress, including no-match and empty-input cases; the original configuration
  resumes correctly. Test capture/reentry with concurrent different-key workers
  and preserve all lookup/cursor/physical state on failure.

Use exact 26.6 and 26.10 qualifications one engine at a time for new engine-sensitive
behavior, then current-head CI. Passing unit tests or the helper diagnostic alone
does not satisfy these gates. Keep PR3234 not merge-ready until the mandatory
writer and recovery tests pass. Quarantine PR3237 is now inherited from main;
keep tiered-storage PR3236 separate. Main's inherited broker guard is not final
tiered-storage qualification.

## Implementation order and review checkpoints

1. Lock in cutover/key-policy regressions and the small fail-closed changes.
2. Add actual sink admission regression and wire the existing owner.
3. Qualify synchronous dbt behavior, add durable child admission, then wire the
   normal/local build, bounded repair and projector boundaries. Review the actual
   caller inventory.
4. Add qualified physical-replay behavior without weakening owner admission.
5. Review the diff for duplicate ownership/tooling, run focused real-engine tests
   and exact-head CI, and reply to the six threads with actual evidence.

No production deployment, migration, pause, key change, image dispatch or broker
operation is included. No automatic owner clearance or broad new tracking
framework is included. These limitations are deliberate availability costs,
not evidence of completed safety work.
