# PeerDB Schema Contract Safety Design

**Date:** 2026-09-13  
**Status:** Approved for implementation

## Problem

Production's `dofek_fitness_raw_analytics` mirror stopped normalizing after
ClickHouse migration `0085_remove_provider_derived_metrics` removed columns
that the live PeerDB table mapping still projected from PostgreSQL. PeerDB
continued to report the flow as running and retained a healthy logical
replication slot, but every normalization attempt failed when it tried to
insert `stress_high_minutes` into `postgres_fitness.daily_metrics`. Because a
failed normalization batch cannot advance later rows, processing markers for
sleep and activity never reached ClickHouse and user-facing recomputes expired
after twelve hours.

The failure was possible because three representations of one contract could
change independently:

1. PostgreSQL source columns;
2. PeerDB table mappings and exclusions;
3. ClickHouse destination columns.

Tests applied database migrations, but no required gate proved that the live
PeerDB projection was insert-compatible with the post-migration ClickHouse
schema. The health check detected stale data only after the configured
freshness window and did not classify a normalization error as an immediate
failure.

## Goals

- Make each PeerDB mirror's projected columns an explicit, typed, canonical
  contract.
- Prevent deployment from making a PeerDB projection incompatible with its
  ClickHouse destination.
- Exercise the real PostgreSQL-to-PeerDB-to-ClickHouse path in integration
  tests.
- Prove each production mirror can cross a causal marker before dependent
  services resume and a rollout succeeds.
- Surface the first normalization failure with the affected flow, table, and
  safe error classification.
- Recover the current production mirror without discarding source data or
  recreating its healthy replication slot.

## Non-goals

- General-purpose schema migration generation for every database.
- Automatic destructive schema changes.
- Increasing reconciliation timeouts, retry counts, or stale thresholds.
- Replacing PeerDB or changing the metric-stream Redpanda path.
- Resnapshotting a mirror whose slot and WAL history remain recoverable.

## Canonical Mirror Contract

Introduce one production TypeScript contract for each PeerDB mirror. Each table
entry contains:

- source schema and table;
- destination database and table;
- explicitly excluded source columns;
- ordering-key metadata already needed by ClickHouse;
- the processing flow name and marker destination used for readiness proof.

The same contract must drive initial mirror creation, reconciliation of an
existing mirror through `flowConfigUpdate`, schema-compatibility validation,
integration fixtures, and operational diagnostics. PeerDB supports column
exclusions when creating or adding table mappings, but does not support editing
the exclusions of an existing table mapping in place. A changed exclusion set
therefore uses the two-phase table remap below
([creating mirrors](https://docs.peerdb.io/sql/commands/create-mirror),
[changing mirror state](https://docs.peerdb.io/peerdb-api/endpoints/change-mirror-state),
[editing mirrors](https://docs.peerdb.io/features/edit-mirror)).

The contract is an allowlisted projection expressed as source columns minus
explicit exclusions. It does not duplicate PostgreSQL types or the complete
ClickHouse table DDL. Those remain owned by their existing schema and migration
systems.

Provider-derived fields removed by migration `0085`, including
`stress_high_minutes`, `recovery_high_minutes`, `resilience_level`, and the
removed sleep-need fields, are exclusions in the relevant table entries. The
contract makes this intent visible to code review and reusable by every guard.

## Compatibility Validator

Add a read-only validator that queries PostgreSQL and ClickHouse catalogs and
computes, for every mapped table:

```text
projected source columns = PostgreSQL columns - contract exclusions
missing destination columns = projected source columns - ClickHouse columns
```

Validation fails when `missing destination columns` is non-empty. It also fails
when an exclusion names no current source column, except during the explicitly
modeled removal phase described below. This prevents misspelled and obsolete
exclusions from silently weakening the contract.

Metadata columns owned by PeerDB, such as `_peerdb_is_deleted`,
`_peerdb_version`, and `_peerdb_synced_at`, are validated separately and are
not treated as PostgreSQL projections.

The validator returns structured table/column differences and never reads row
data. The deploy command prints identifiers only; it does not print connection
strings or credentials.

## Schema-Change Protocol

Cross-system destructive changes cannot be atomic, so deployment must preserve
compatibility at every intermediate state.

### Adding a mirrored source column

1. Add the destination column with compatible nullability and type.
2. Validate that the old projection remains compatible.
3. Add the PostgreSQL source column or remove its temporary exclusion.
4. Reconcile the live PeerDB contract.
5. Run compatibility validation and the causal marker canary.

PeerDB documents automatic propagation for some additions, but connector
behavior differs by destination; Dofek therefore does not rely on implicit
propagation for deployment safety
([schema-change support](https://docs.peerdb.io/features/schema-changes)).

### Removing a mirrored source or destination column

1. Quiesce the affected mirror and all dependent reconciliation/analytics
   services through the existing deployment overlay.
2. Add the source column to the canonical exclusion list.
3. Pause the live mirror, remove only the affected table mapping through
   `removed_tables`, and read the configuration back until the mapping is
   absent.
4. In a second update, add the table mapping through `additional_tables` with
   the canonical exclusions. PeerDB forbids adding and removing the same table
   in one update, so these are separate verified transitions.
5. Wait for the table snapshot to finish, the mirror to return to
   `STATUS_RUNNING`, and the read-back mapping to contain the exact exclusions.
6. Run compatibility validation while the destination column still exists.
7. Apply the ClickHouse column-drop migration.
8. Require the causal marker canary to succeed.
9. Resume dependent services only after the canary succeeds.
10. Remove the PostgreSQL source column in a separately compatible migration if
   the canonical source no longer stores it.

No step may warn and continue. If the live mirror cannot be reconciled or read
back, deployment stops with the affected flow, table, and column names.

## Integration Tests

The database-backed integration tier will contain two complementary tests.

### Deterministic compatibility test

Apply the real PostgreSQL migrations and ClickHouse migrations, load the
canonical mirror contract, inspect both catalogs, and run the same validator
used by deployment. The regression fixture verifies that migration `0085` is
compatible only when the removed provider-derived columns are excluded.

This is the fast, precise failure for ordinary pull requests. It must execute
against the real database engines; a test that merely matches SQL strings is
insufficient.

### End-to-end PeerDB contract test

Start the repository's PeerDB Compose overlay with PostgreSQL and ClickHouse,
create the mirror from the canonical contract, and insert a minimal fixture for
each mapped table. For each mirror, publish a unique processing marker and wait
within a bounded interval for the exact marker in its assigned ClickHouse
destination. The test fails on a PeerDB normalization error, a schema mismatch,
or a missing marker.

This suite validates generated configuration and actual PeerDB behavior. It
runs in an explicit CDC integration project so ordinary Docker-free unit tests
remain fast. CI may shard it independently, but it is a required pre-merge and
pre-deploy check for changes to PostgreSQL schemas, ClickHouse migrations,
mirror contracts, or PeerDB setup code.

Fixtures use dedicated temporary databases or uniquely named test mirrors and
clean up only those resources. They never replay production migrations that
perform heavyweight historical backfills.

## Production Canary

After schema migration and mirror reconciliation, deployment writes a unique
operation/dataset/batch marker through the existing
`fitness.processing_flow_marker` path for each mirror. It then queries only the
destination table assigned to that flow and requires the exact marker and
source watermark.

This reuses the application's causal readiness contract instead of relying on
an unrelated maximum domain timestamp. It proves that WAL capture,
normalization, ClickHouse insertion, and the correct destination mapping all
work for the deployed schema.

The canary has a bounded deadline and no warn-and-continue branch. Failure
leaves dependent workers quiesced and preserves the mirror and replication slot
for diagnosis.

## Monitoring

Extend CDC health classification so a PeerDB normalization/destination-schema
error is immediately unhealthy rather than waiting for table freshness to age
past its threshold. The emitted event contains:

- flow name;
- destination table;
- error class/code;
- safely parsed missing-column name when available;
- first and latest occurrence timestamps.

The event excludes generated SQL, row data, credentials, and connection
details. Existing stale-mirror, slot-state, and retained-WAL checks remain
independent supporting evidence. A flow's nominal `running` state is not
accepted as health when normalization is failing.

## Current Incident Recovery

The production recovery uses the same steady-state mechanism:

1. Pause `dofek_fitness_raw_analytics`.
2. Remove the `daily_metrics` and `sleep_session` table mappings in one paused
   update and verify that both are absent.
3. Add both mappings back in a second update with the canonical exclusions.
4. Wait for their snapshots to complete and read back the exact exclusions.
5. Continue using the existing mirror and active, reserved slot; do not recreate
   either one.
6. Require the exact processing marker to arrive in
   `postgres_fitness.processing_flow_marker`.
7. Verify the WAL backlog drains, sleep/activity mirror timestamps advance,
   reconciliation completes, and the user-facing activity and sleep queries
   return current data.

Resync remains a fallback only if evidence shows the existing slot or mirror
cannot recover. PeerDB's resync operation replaces the mirror and replication
slot and performs a new snapshot, so it carries materially more source load
([resyncing a mirror](https://docs.peerdb.io/features/resync-mirror)).

## Rollout and Failure Handling

Implementation lands in this order:

1. canonical contract and deterministic validator;
2. failing regression coverage, then corrected exclusions/config generation
   and two-phase existing-table remapping;
3. real PeerDB integration project;
4. deploy-time readback, compatibility gate, and marker canary;
5. immediate normalization-error health classification;
6. current production recovery through the validated path.

Every phase is fail-closed. No migration threshold, timeout, or retry is
increased. Rollback must not remove additive safety code or undo a successfully
applied exclusion. If rollout fails after a mirror is paused, operators inspect
and preserve its current slot before resuming or choosing a separately approved
resync.

## Success Criteria

- CI reproduces the `stress_high_minutes` incompatibility before the fix and
  passes after the exclusion is applied.
- Changing any mapped PostgreSQL or ClickHouse schema without a compatible
  mirror-contract update fails a required check.
- A production deployment cannot resume dependent services until every mirror
  crosses its exact causal marker.
- A first normalization schema error makes CDC health fail with an actionable,
  sanitized table/column diagnosis.
- The existing production fitness mirror catches up without a slot drop,
  destination truncation, or full resnapshot.
