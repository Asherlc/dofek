# Erasure extraction checkpoint — not merge-ready

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
normal passing suite. Apply with stock `git apply --unidiff-zero` to reproduce, then run:

```sh
pnpm exec vitest run --project integration src/metric-stream/clickhouse-sink.integration.test.ts -t 'does not republish' --retry=0
```

Use the workspace test database/ClickHouse environment as described in
[testing](../../testing.md). No broker is involved in this particular fixture.
The diagnostic completed the real fence SELECT, activated the real account fence
and completed synchronous `ALTER TABLE DELETE` immediately before the actual
sink insertion. It failed at the final assertion: **expected 0 rows, received 1**.
The original run used the repository's default two retries and failed each time.
All temporary rows and fences were removed in `finally`.

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
  unchanged until completion. The diagnostic must then prove no resurrection.
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
