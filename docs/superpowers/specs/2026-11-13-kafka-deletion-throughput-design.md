# Kafka deletion-batch throughput

The user approved fixing deletion-batch throughput after the November 13 backlog
investigation. Keep the existing publication and erasure safety design.

## Problem and evidence

The live backlog grew while its consumer remained healthy. Axiom recorded live
batches containing 1,823 deletion events and taking about 850–872 seconds,
including ownership wait. PostgreSQL showed analytics and sink batches holding
the same exclusive publication resource. In a 30-minute ClickHouse sample,
38 deletion queries read 2,771,302,724 rows and consumed 313 seconds of server
execution; 3,646 acknowledgement inserts were separate requests. The source
emits a candidate-table scan per scope and acknowledgement requests per event.
The existing [publication safety decision](../../plans/2026-11-09-erasure-safety-decisions.md)
explicitly requires shared ownership; this change preserves it.

## Approach

Use the existing sink, SQL predicates, synchronous client and bounded groups.
Read acknowledged event IDs in arrays of at most 100. Insert acknowledgements
in one JSONEachRow command per successfully applied deletion chunk. Discover
candidate identities with one table read whose predicate is the OR of the
chunk's complete scope predicates, then retain the existing complete latest-row
resolution and latest-scope recheck. Avoid a UNION ALL table scan per scope.

This follows ClickHouse's [client-side batching guidance](https://clickhouse.com/docs/optimize/bulk-inserts).
No new dependency, schema, index, service, abstraction or configuration is needed.

Alternatives considered: an analytics pause can reduce some lock wait but does
not remove deletion amplification and delays derived-data freshness. Extra sink
replicas cannot bypass the shared publication owner. Changing lock granularity
would change the accepted erasure/recovery design. None is part of this fix.

## Invariants

- Preserve event order, revision boundaries, replacement-row boundaries and
  legacy V1/V2 replay behavior. A V3 run remains adjacent and same-revision.
- Preserve the existing 100-scope deletion bound and bounded metadata sizes.
- Persist deletion scopes and successfully apply tombstones before acknowledging
  their event IDs. Stop on failure before dispatching later acknowledgement,
  replacement-row or marker work. Earlier writes and receipts remain persisted;
  an uncertain response does not prove write absence. Preserve owner recovery
  and redelivery requirements rather than inventing rollback or automatic retry.
- Preserve nullable external-ID semantics, mutable identity resolution, integer
  revisions, cross-route ordering, account erasure fences and provider generations.
- Preserve shared durable ownership, reservations, terminal response checks,
  consumer heartbeat, offset commit ordering and graceful shutdown.

## Acceptance

Real ClickHouse fixtures must reproduce excessive reads/requests before the
change and pass afterward. Verify exact final rows and acknowledgements,
partial acknowledged redelivery and existing ordering/failure regressions.
Measure reads and requests through native query IDs and
[system.query_log](https://clickhouse.com/docs/operations/system-tables/query_log),
not SQL-string snapshots or wall-clock-only thresholds.

Run focused unit and integration suites, full unit/mobile tests, repository
lint, root/server/web TypeScript checks and independent safety/quality review.
Push commits automatically and use the canonical CI/release path. Keep monitoring
the actual production commit/end offsets after release: this optimization does
not itself prove sustained catch-up while analytics retains the shared lock.
If a remaining bottleneck requires a different safety/scheduling approach,
report the measured limitation before changing that approach.
