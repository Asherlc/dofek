# Erasure extraction checkpoint — not merge-ready

The [2026-11-09 safety decision package](../../plans/2026-11-09-erasure-safety-decisions.md)
turns the remaining choices below into one reviewable implementation direction
against the branch synchronized with main. It adds the concrete local-build and
bounded-repair writer callers and key-binding enforcement to the earlier
proposal. The user has approved implementation followed by merge; the
[execution plan](../../superpowers/plans/2026-11-09-erasure-safety-implementation.md)
tracks that work. Its fixes and acceptance tests are not yet claimed complete.

This is offline candidate evidence, not a production release approval. No
production deployment, migration, pause, acknowledgement or historical identity
scan was performed. Source reference: `ed26f38b8`; base: `2752451fb4`.

## Alias fix

The [effort model](../../../analytics/models/read_models/activity_effort_identity.sql)
derives persisted `canonical_activity_id` from activity membership. The
[route model](../../../analytics/models/read_models/activity_route_identity.sql)
also persists it. The [cycling history](../../../analytics/models/read_models/cycling_threshold_history.sql)
and [activity metrics](../../../analytics/models/read_models/cycling_activity_power_metrics.sql)
persist `evidence_activity_id` through `toUUIDOrNull`.
These two UUID relations now use the existing activity identity family in
[the typed catalog](../../../src/account-erasure/clickhouse-erasure-coverage.ts).
No table exemption, harmless-identifier allowance or scope/budget increase is added.

The extended real-engine group/source relation fixture first failed with
`canonical_activity_id is not mapped to an ownership relation`. With the typed
declarations it passed physical deletion, preserving null relations and explicit
other-owner rows. The existing transitive/group/string-family checks run in that
same fixture. Initial engine: **26.9.19**, diagnostic only. Exact 26.6/26.10
qualification is recorded below when completed.

| Exact engine | Catalog-budget cases | Physical alias/group erasure |
|---|---|---|
| 26.6.1.1193 | 3 passed | 1 passed |
| 26.10.2.103 | 3 passed | 1 passed |

Both exact-version runs used `--retry=0`, isolated ephemeral Compose services
through the workspace wrapper, and the same extracted candidate fixtures.
The production-version image digest is pinned in the
[source qualification receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/clickhouse-catalog-budget-20261108/README.md).
These are local tests, not a production inspector result or full release
qualification. The original full 37-case erasure suite has not been rerun.

Focused units after excluding Kafka-only acknowledgement and unused coordinator
modules: **746 passed / 32 files**, including **169 catalog cases**, with retries
disabled. Identical-source budget evidence is historical context only.
The identifier-store/migration and request-processing database suites passed
53 cases; the request-to-completion suite passed its 3 cases after adapting the
retention expectations to Redpanda. Root and server TypeScript checks passed.
Changed TypeScript files passed Biome. Full lint, all integration suites,
broker-dependent checks and a new image/production inspector run remain
outstanding; passing focused checks do not remove the publication safety gate.

## Proven publication race

[publication-race.patch](publication-race.patch) retains an intentionally failing
diagnostic against the actual sink integration suite; it is not installed in the
normal passing suite. Apply with stock `git apply` to reproduce, then run:

```sh
pnpm exec vitest run --project integration src/metric-stream/clickhouse-sink.integration.test.ts -t 'does not republish' --retry=0
```

Use the workspace test database/ClickHouse environment as described in
[testing](../../testing.md). No broker is involved in this particular fixture.
The diagnostic completed the real fence SELECT, activated the real account fence
and completed synchronous `ALTER TABLE DELETE` immediately before the actual
sink insertion. It failed at the final assertion: **expected 0 rows, received 1**.
The original run used the repository's default two retries and failed each time.
All temporary rows and fences were removed in `finally`. The review follow-up
rebased the diagnostic patch context onto the current test file and added an
unfenced control. With retries disabled, that control remained queryable (1 row)
before the target assertion still failed (expected 0, received 1). This helper
diagnostic is historical evidence, not qualification of the production
`handleEvents` admission boundary.

The causal path is
[`applyMetricStreamEventsToClickHouse`](../../../src/metric-stream/clickhouse-sink.ts):
`filterEventsByAccountErasureFence` reads before
`insertMetricStreamEventsIntoClickHouse` writes. The sink has no shared ownership
boundary with the [erasure runtime](../../../src/jobs/account-erasure-runtime.ts).
The frozen source also has no publication caller of its new delivery coordinator.
The existing [refresh queue](../../../src/analytics-refresh-queue.ts) serializes
refresh jobs, while erasure and the raw sink run separately.

## Proposed safety work — requires alignment

One proposed strategy is to extend the existing publication ownership boundary
to actual publication callers; do not add another coordinator framework.

- In `runMetricStreamClickHouseSinkFromEnv` / `handleEvents`, admit each batch
  through the same durable publication resource used by erasure. Hold account
  delivery guards through fence membership, insert/delete effects and terminal
  completion. Recheck the account fence after admission; keep source offsets
  unchanged until completion. Production-path acceptance tests must prove no
  resurrection through `handleEvents`; the direct-helper diagnostic can still
  fail when callers provide the protection.
- Keep erasure identity preparation, ingest fence and physical delete under that
  same resource. Do not release ownership just because a PostgreSQL session ends.
  The existing query-owner module tracks ClickHouse query IDs and terminal state;
  an unresolved/asynchronous query or lost owner must leave admission blocked
  until terminal completion is verified. PostgreSQL advisory locks alone cannot
  prove a previously submitted remote query has stopped.
- `runAnalyticsBuildFromEnvironment` is still uncovered: its spawned dbt process
  uses independent connections, and its cycling projector writes directly.
  The normal analytics worker and any explicit local/operator build entrypoint
  must share the boundary or be excluded by an enforced execution precondition.
  Merely wrapping the parent process with a PG lock does not establish remote
  query termination after a crash. How dbt queries acquire a verifiable terminal
  boundary remains a design decision; no new tracking is implemented here.

Required acceptance tests: delayed sink admission versus fence activation; insert
already submitted when ownership is lost; crash/connection loss with a remote
query outstanding; erasure waiting for an in-flight build; null/direct ownership
and unrelated-account preservation after those races. Use real databases and
the actual production publication functions.

The mandatory requirement is exclusion of every writer capable of republishing
erased data through terminal remote completion. General-purpose tracing or a new
tracking framework is optional and not authorized. The tradeoff is broader writer
integration than a mapping fix; the current limitation is that this candidate
cannot claim race-safe physical erasure or release readiness.

ClickHouse documents [synchronous mutation settings](https://clickhouse.com/docs/operations/settings/settings#mutations_sync)
and [query cancellation](https://clickhouse.com/docs/sql-reference/statements/kill).
PostgreSQL documents [session and transaction advisory lock lifetime](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

## Local dependency limitations

`pnpm test:integration -- ...` initially failed while starting the full workspace
stack: Redpanda logged `Could not setup Async I/O` and reported the host
`aio-max-nr` capacity exhausted. Postgres, ClickHouse and Redis were healthy.
Focused database-only fixtures then ran with their generated workspace URLs and
`TEST_DATABASE_URL`; no broker-dependent test is claimed to have passed.
The separate 26.10 lab could not allocate another Docker network (`all predefined
address pools have been fully subnetted`), so its temporary Compose definition
used the already-owned workspace network. No production or other workspace
resources were modified; no retry/timeout changes were made to repository code.

## Review verification and remaining decisions

The successful [58d9c75d5 CI run](https://github.com/Asherlc/dofek/actions/runs/42507552488)
completed all checks, including the unchanged integration deadline. The retained
[catalog report](catalog-ci-report.txt) independently confirms 180 catalog tests
and 93.04% mutation score; these links supersede the earlier failing CI job as
evidence for those counts. They do not remove the writer-safety gate.

Review fixes use the SDK's stock `ResultSet` stream parser for owned commands;
[ClickHouse's HTTP documentation](https://clickhouse.com/docs/interfaces/http#http-response-codes-caveats)
explains why HTTP 200 alone cannot prove success. The unused owned `exec` API
is removed rather than returning consumed bytes or adding a result replay buffer.
The native SDK HTTP-200/exception-body regression failed before the fix and passed
after it. Real PostgreSQL reservation cleanup covers one valid descriptor, none,
an insufficient high-watermark and multiple eligible descriptors.

### Smallest proposed safety follow-up (approval required)

Use the existing `ANALYTICS_PUBLICATION_RESOURCE` row and owner module, without
new tables, receipts or a parallel coordinator:

1. In [sink `handleEvents`](../../../src/metric-stream/clickhouse-sink.ts), acquire
   publication ownership before fence membership and retain it through all actual
   insert/delete commands and their consumed terminal responses. Keep acknowledgement
   after completion. Replacements must acquire the same ownership before drain can advance.
2. In [`runAnalyticsBuildFromEnvironment`](../../../scripts/run-analytics-build.ts),
   cover the complete build, including the spawned dbt child and
   [`projectCyclingPower`](../../../src/analytics/cycling-power-projector.ts).
   Normal workers and direct script invocations must use this same entry boundary.
   Direct exported projector callers also need the boundary at publication.
3. Retain the same owner across erasure preparation, fence publication and physical
   verification in the [runtime](../../../src/jobs/account-erasure-runtime.ts).
   The raw PostgreSQL advisory lock is only mutual exclusion while its session lives.
   Extend the existing durable owner to retain non-quiescent state for the dbt child;
   its current generic callback cleanup would otherwise release an unregistered child.
   Retire only after qualified synchronous adapter completion. A parent crash,
   abnormal child exit or uncertain remote request must keep the existing owner
   blocked; do not infer termination from an absent session/process or auto-clear it.

Acceptance: real production entrypoints with delayed fence/read/write, consumer
replacement, parent/child termination and outstanding remote requests; prove
erasure cannot certify/scrub while any admitted executor can publish, and prove
unrelated owners survive. Qualify successful dbt adapter completion and crash
retention explicitly before claiming coverage. This is mandatory safety work,
not optional tracing. Tradeoff: conservative blocked recovery after uncertain
execution; automatic dbt crash recovery is not proved or proposed as a new framework.

Other review findings need a bounded decision before implementation:

- **Physical admission recovery:** [the physical flow](../../../src/account-erasure/clickhouse-physical-erasure.ts)
  durably admits before dispatch. A crash in that gap leaves no mutation evidence,
  so retries fail closed. Proposed minimum: replay the exact frozen DELETE only
  after existing ownership proves the former executor/requests terminated, while
  preserving all captured parts, schema binding and mutation lineage. Acceptance
  must cover before-dispatch crash, in-flight ambiguity, completed response loss
  and inactive/projection-part retention. Never treat missing evidence as success.
- **Legacy route-less checkpoints:** [0179](../../../drizzle/0179_account_erasure_identifiers.sql)
  currently admits scrubbed unfinished requests although their old quarantine
  checkpoints may lack topic attribution. That attribution cannot be reconstructed
  from an ambiguous array safely. Proposed minimum: block cutover on all unfinished
  legacy requests and complete them with their original worker first. This changes
  release timing and requires alignment; no offsets or checkpoints are guessed.
- **Credential master-key rotation:** [retained keys](../../../src/account-erasure/identifier-store.ts)
  are derived from the master key and appear in cursor/proof state, not just
  ciphertext. The [existing rotation contract](../../credential-encryption.md)
  already requires a data migration. Proposed minimum: prohibit master-key rotation
  while any retained erasure request exists; drain and purge through normal
  completion first. Supporting in-place rotation would instead require an atomic
  re-key of identities, encryption contexts and dependent cursor/physical state.
  Neither a partial ciphertext-only rotation nor a new keyring framework is implemented.

The review follow-up passed 146 focused units, 13 real-database boundary/status
cases, root TypeScript and changed-file Biome checks. The revised diagnostic's
unfenced control passed before its expected target-row failure. A further full
physical crash/cleanup case was attempted after adding the bounded native-exec
fixture, but PostgreSQL setup ran out of disk before the test body; no local pass
is claimed for that attempt. Latest-head CI must qualify that path.
