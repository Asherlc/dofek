# Processing reconciliation inactivity

Status: approved by the operator on November 11, 2026. The user selected preparing a durable stale-rule fix before production recovery and approved this timestamp-based design.

## Problem and intent

The November 11 Strava continuation retained an operation created November 3. It produced current output and completed ingestion, but the reconciler abandoned its pending downstream work because the operation's original creation time exceeded 12 hours. Preserve the existing operation identity, exact receipt checks and 12-hour guard while allowing an old operation to make genuine new progress. See the [incident evidence](../../production-incident-baseline.md#history-ingestion-completed-stale-reconciliation-is-a-confirmed-blocker).

## Approaches

- Increasing the threshold or removing abandonment leaves genuinely inactive work pending longer and does not distinguish progress from age.
- Creating a new operation for every continuation changes the established cross-job processing identity and splits its evidence.
- **Recommended:** use the newest existing reconciliation outbox creation timestamp as the inactivity reference. Both canonical commits and published metric batches create their reconciliation work through the [event store](../../../src/processing/processing-event-store.ts). Reconciliation polls and dispatch updates do not create a new producer output timestamp.

The user selected a durable correction rather than an operator-only requeue. The timestamp choice above is the proposed implementation of that direction.

## Small implementation

Change the pending-operation query/schema in [the reconciler](../../../src/processing/processing-reconciler.ts) to return `MAX(outbox.created_at)` as the last output time, replacing the operation-creation age check. Keep the strict greater-than-12-hours boundary, oldest-pending-work ordering, batch limit, exact marker/receipt comparisons, ingest-finish requirement and analytics dispatch behavior. PostgreSQL provides the existing [timestamp aggregate](https://www.postgresql.org/docs/current/functions-aggregate.html); no new dependency, stored timestamp, timer, schema migration or retry mechanism is needed.

Use the current query's database snapshot and existing outbox lifecycle; do not add a new locking or ownership protocol. A concurrency concern discovered during review must be reported before expanding the approach.

## Acceptance and verification

Tests must reproduce the old-operation/new-output failure before the source change. Real PostgreSQL/ClickHouse tests must show that an old operation with an old batch and a newly published batch stays pending until the exact evidence arrives, then dispatches analytics normally. Another real-engine case must show genuinely inactive output still becomes `processing_stalled`, even after recent reconciliation/dispatch bookkeeping. Unit cases cover the exact 12-hour boundary and already-complete evidence. Reuse the existing suites and minimal schemas; do not replay historical backfills. Run focused tests, full lint and required typechecks before pushing; review the actual diff and evidence.

## Production boundary

This work prepares and validates the durable code change. The Strava queue stays paused, its original operation and completed ingestion stay intact, and Sentry remains open. Deployment and any re-arming of the already-abandoned operation require a later explicit operator approval. The fix does not automatically rewrite historical outbox states.
