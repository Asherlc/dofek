# Provider ACK access assessment before fix round1

Reviewed the complete Important finding in `task-2-provider-protocol-review.md`.
The current reverse metadata lookup has no useful event-ID primary-key predicate;
`FINAL` plus `LIMIT 1` still scans unrelated operations in the no-conflict case.

Finite native probe: `provider-ack-access-probe.integration.ts` (assessment-only
artifact, moved out of source discovery after execution). Both runs used the
private runner with `--retry 0 --bail 1`, isolated current-schema CH/PG fixtures,
65536 real unrelated legacy ACK rows, no global/service/optimizer/cap changes.

- `provider-ack-access-assessment.log`: initial projection ADD rejected because
  ReplacingMergeTree defaults to `deduplicate_merge_projection_mode=throw`.
  The private fixture was cleaned and runner exited1; no resource fatal.
- Root explicitly permitted changing only the disposable fixture's table mode to
  `rebuild` for compatibility assessment. `provider-ack-access-assessment2.log`
  passed1/1; installed engine **26.10.2.103**. Fully materialized projection sorts
  by nullable-normalized deletion/predecessor then event ID and contains all
  requested columns. Both exact query plans report `FINAL:1`, primary-key
  `Condition:true`, **8/8 granules**. Actual QueryFinish profiles:
  `bcec4975-e324-4623-9af8-fb6ca29d5461` baseline and
  `08248a6e-e4d3-4dc2-b6c4-c27b353dd687` projected each read **65536 rows** with
  `projections=[]`. Runner exited0; own fixture cleaned.

This matches the current [official projection comparison](https://github.com/ClickHouse/clickhouse-docs/blob/main/docs/data-modeling/projections/2_materialized-views-versus-projections.md),
which describes `FINAL` as incompatible with projections. The native evidence
above, rather than that general documentation alone, excludes a projection-only
fix for this installed engine.

Root approved and implemented focused fix: derive each command UUID from a fixed
namespace plus `[deletionEventId,previousCommandId|null]`, enforce that relation
in the strict wire codec, and derive the ID in the command constructor. There is
one root slot and one successor slot per predecessor. Page contents and operation
identity remain in the existing immutable SHA-256 command hash, not the slot
derivation. Existing event-ID `FINAL` point lookup then either verifies the same
command/receipt or rejects changed content/identity. Exact predecessor operation,
receipt and native ordering checks remain. A different command ID for the same
predecessor is invalid at the codec/admission boundary; a different page sharing
its canonical ID fails the immutable hash. The existing global pending owner
still protects the commit-before-ACK gap.

The proposal preserves the sole ACK store, its primary key/legacy NULL rows,
original first ACK position and terminal top-level deletion event ID. Legacy
archived scope event IDs and pre-migration job operator-redrive rules are
unchanged. It deliberately tightens only this wholly unreleased command-ID
contract; it does not add aliases/adoption of previously published arbitrary
provider command IDs. Normal durable ACK retention/bootstrap remains required;
no new claim covers arbitrary loss of command metadata.

The approved fix's regressions exercise substantial unrelated ACK history and
actual `FINAL` primary-key plan/read rows alongside fork, changed-content and
operation-identity rejection. The original1001-effects qualification remains
unchanged/OPEN, without timeout inflation or a substitute fixture.
