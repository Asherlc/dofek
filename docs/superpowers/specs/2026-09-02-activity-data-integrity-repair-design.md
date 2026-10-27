# Activity data integrity repair

## Goal

Correct false cross-provider activity groups and contradictory local-time
contexts without altering raw provider observations. Repair the derived
ClickHouse activity views once after the canonical Postgres rows have been
corrected, and make MCP activity summaries explicit about power availability.

## Scope

### Forward behavior

- Treat a Peloton fixed `Etc/GMT±N` value as an offset-only observation. Derive
  its offset from the IANA zone at the activity instant; do not persist the
  fixed-zone name as a geographic timezone and never trust a separately
  supplied offset that contradicts it.
- Restrict containment matching so an `other` activity can join a typed
  activity only when it is a supported untyped representation of that same
  activity. It must not connect unrelated, overlapping provider activities.
- Hydrate an activity only from a sensor summary for a member compatible with
  the visible group's canonical type and raw/provider identity. An incompatible
  member is not a fallback source.
- Return a `power_by_modality` object for every activity-summary group, with
  `indoor`, `outdoor`, and `unknown` strata. Each stratum contains its own
  `avg_power`, `max_power_peak`, and coverage; no blended power average or peak
  is emitted. Each aggregate requires at least three power-bearing activities.
  A missing aggregate is `null`, never omitted.
- Preserve the existing missing-data representation: unavailable elevation is
  `null`; measured zero remains `0`.

### Historical repair

A single bounded TypeScript operational command will accept a user and explicit
UTC window, default to dry-run, and require `--execute` for writes. It will:

1. Snapshot every selected activity's pre-state and the affected derived-group
   membership to a JSON audit artifact before any write.
2. Recompute local-time context from raw/provider facts, including every
   timezone/offset consistency check.
3. Re-evaluate duplicate edges and derived group membership from the complete,
   immutable raw activity set using the forward matching rule. The graph's
   connected components are computed from those edges in one transitive pass;
   the result is independent of prior group membership, so a second pass cannot
   discover a newly enabled edge. It will not mutate raw source identity,
   metrics, or provider payloads.
4. Mark precisely those Postgres and ClickHouse source keys dirty, then run the
   bounded dbt/read-model rebuild for those keys.
5. Emit before/after counts, changed IDs, incompatible-member count, and the
   audit-artifact path. A second execution with unchanged source state is
   idempotent.

Rollback restores only the captured pre-state, with compare-and-swap predicates
for the values written by this run. It will reject a stale audit artifact rather
than overwrite a subsequent provider sync. It writes the old derived values
with a strictly newer `ReplacingMergeTree` version, never their original
version. PostgreSQL `UPDATE ... RETURNING` supports recording the rows actually
changed; updates will be batched and ordered to control lock and replica impact.
[PostgreSQL UPDATE documentation](https://www.postgresql.org/docs/current/sql-update.html)

The repair writes a newer derived-row version rather than mutating raw sensor
samples. Verification reads the relevant `ReplacingMergeTree` tables with
`FINAL`, so asynchronous part merging cannot produce false failures. This
conforms to the repository's read-model pattern and dbt incremental-model
ownership. [ClickHouse ReplacingMergeTree documentation](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree), [dbt incremental-model documentation](https://docs.getdbt.com/docs/build/incremental-models)

Each audit artifact is retired only after its post-run verification is accepted.
No subsequent historical repair may begin while an earlier artifact remains
rollback-eligible. If a later repair is intentionally allowed to supersede it,
the runbook records that the earlier rollback window has closed.

## Required diagnosis before implementation

- Run the member-summary query for `2a7c6fa3` and `761483e6`. If their selected
  summaries differ by member, resolve the remaining speed defect through group
  hydration; if both are Wahoo summaries, retain speed conversion as a separate
  root-cause track.
- For Strong activities `6ca753f3` and `369e6444`, inspect the activity and
  strength-set parent IDs, exact names (including trailing whitespace), and
  parsed external IDs. Distinguish misattachment from absent import before
  changing identity generation.
- Trace the raw heart-rate sample that produces `walking.max_hr_peak = 189`;
  repair its source linkage or ingestion only after the trace identifies which.

## Verification

- Unit tests cover fixed-zone normalization, mismatched supplied offsets,
  incompatible containment matches, modality coverage, the three-observation
  power minimum, and `null` elevation serialization.
- Real Postgres/ClickHouse integration tests re-evaluate a false group, verify
  that it splits, and verify the hydrated result cannot consume an incompatible
  member summary.
- Dataset invariant queries assert that every persisted timezone/offset pair is
  internally consistent and every hydrated summary member is compatible with
  its group's canonical/provider/raw identity.
- The operational command is tested for dry-run, idempotence, bounded batches,
  compare-and-swap rejection, and rollback from a captured audit artifact.
- MCP end-to-end fixtures assert the observed failures: `2a7c6fa3` has no
  Peloton source and an internally consistent local-time context; `894ce621`
  has matching zone and offset; low-count `other` power is null with coverage;
  `running` cannot inherit the 423 W peak; and unavailable kayaking elevation
  remains null.

## Out of scope

Unclassified activity-rate reduction is deferred until the repaired grouping
has been measured. The unclassified percentage may initially rise because
incorrectly inherited types become truthful `other` records; that is an
expected integrity correction, not a classification regression. Outdoor Wahoo
power remains absent when no raw provider field or sensor sample exists.
