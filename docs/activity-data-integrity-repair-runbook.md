# Activity Data Integrity Repair Runbook

Use this runbook to correct contradictory activity local-time context and then
rebuild the affected activity grouping and summary read models. The operation
changes only the canonical local-time fields on `fitness.activity` and newer
versions of derived ClickHouse rows. It does not alter provider identity,
provider payloads, activity metrics, or raw sensor observations.

This is a manual, bounded operation. It is not a deployment step. Every run is
scoped to one user and an explicit half-open UTC window. The command defaults
to dry-run and writes a private JSON audit artifact before any execute-mode
database update.

## Safety model

- Use an individual operator identity, such as the production data on-call's
  email, as the acceptance owner. Team aliases are not acceptable because the
  retirement receipt must identify one accountable person.
- Set the acceptance deadline no more than 24 hours after execution begins.
  Before that deadline, the named owner must either accept and retire the
  artifact or roll the repair back.
- A PostgreSQL session advisory lock serializes repair and rollback operations
  globally, including runs that use different artifact directories. The lock
  is held while the artifact scan, database work, and final artifact transition
  run, which closes the scan/create race. PostgreSQL documents session-level
  advisory locks in its [explicit locking reference](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
- Only one rollback-eligible activity-integrity artifact may be active in an
  artifact directory. The command rejects another execute run until the prior
  artifact has been retired or successfully rolled back.
- Do not start the separate Strong identity or speed investigation while this
  artifact remains rollback-eligible. Accept or roll back this repair first so
  later writes cannot invalidate its compare-and-swap boundary.
- PostgreSQL updates are batched inside a transaction and use
  `UPDATE ... RETURNING` compare-and-swap predicates over the captured identity,
  time, and local-time fields. A mismatch aborts the whole Postgres update
  instead of overwriting a later provider sync. See the
  [PostgreSQL transaction](https://www.postgresql.org/docs/current/tutorial-transactions.html)
  and [`UPDATE`](https://www.postgresql.org/docs/current/sql-update.html)
  documentation.
- Rollback restores captured ClickHouse values by inserting a strictly newer
  decimal `UInt64` version. Verification always reads `ReplacingMergeTree`
  tables with `FINAL`, so the visible result does not depend on background part
  merges. See the
  [ClickHouse `ReplacingMergeTree` documentation](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree).
- After PostgreSQL commits, execution waits for the changed rows to appear in
  the ClickHouse PostgreSQL mirror with their repaired local-time fields. This
  readiness check is condition-based, bounded to two minutes, and fails before
  dbt starts if CDC has not caught up.

## Preconditions

1. Confirm the local-time normalization, duplicate matching, group derivation,
   hydration, and modality-aware summary changes are deployed together.
2. Confirm `DATABASE_URL` and `CLICKHOUSE_URL` resolve to the intended
   environment. Do not copy credentials into the audit artifact or terminal
   history.
3. Choose one user UUID and a narrow UTC window. `--start-at` is inclusive and
   `--end-at` is exclusive. Start with the smallest window containing the
   affected activities.
4. Create a durable, access-controlled directory outside the repository. Keep
   the audit artifact and its retirement receipt together. The command creates
   new directories with mode `0700` and files with mode `0600`.
5. Record the named acceptance owner and a UTC deadline within the next 24
   hours. The owner must be available for the entire verification window.

## 1. Dry run

Run through the repository environment wrapper. Do not add `--execute`:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts \
  --user-id=<user-uuid> \
  --start-at=2026-09-01T00:00:00Z \
  --end-at=2026-09-02T00:00:00Z \
  --batch-size=250 \
  --max-batches=20 \
  --artifact-directory=/secure/dofek/activity-integrity/2026-09-02
```

The JSON result must report `kind: "dry-run"`, `updated: 0`, and the artifact
path. Inspect the artifact without editing it. Confirm:

- `userId` and `window` are exact;
- `selected` fits within `batchSize * maxBatches`;
- `changedActivityIds` contains only intended rows;
- every `postgresActivities[].prior` and `.repaired` transition is explainable
  from the provider timezone or offset;
- `componentsBefore` contains the expected false groups; and
- the before-state contains rows for all seven Task 3 models:
  `activity_source_records`, `activity_duplicate_matches`,
  `activity_duplicate_groups`, `deduped_activities`,
  `deduped_activity_members`, `activity_sensor_summary_rows`, and
  `activity_summary_rows`; and
- `highestDerivedVersion` is a decimal string, not a rounded JavaScript number.

Stop if selection reaches the configured maximum, an unrelated activity would
change, a proposed offset is not explainable, or the component set is
unexpected. Narrow or correct the inputs; do not execute an unexplained diff.

## 2. Capture the read-only baseline

Before execution, save the results of these queries with the change record.
Supply the same user and UTC window as named query parameters in the approved
PostgreSQL and ClickHouse clients.

PostgreSQL local-time state:

```sql
SELECT
  id,
  provider_id,
  external_id,
  started_at,
  ended_at,
  timezone,
  start_utc_offset_minutes,
  end_utc_offset_minutes,
  local_time_source
FROM fitness.activity
WHERE user_id = '<user-uuid>'::uuid
  AND started_at >= '2026-09-01T00:00:00Z'::timestamptz
  AND started_at < '2026-09-02T00:00:00Z'::timestamptz
ORDER BY started_at, id;
```

Visible ClickHouse source and group state:

```sql
SELECT
  toString(source.activity_id) AS activity_id,
  source.provider_id,
  source.timezone,
  source.start_utc_offset_minutes,
  source.end_utc_offset_minutes,
  source.local_time_source,
  toString(groups.group_id) AS group_id,
  toString(greatest(source.refresh_version, groups.refresh_version)) AS visible_version
FROM analytics.activity_source_records AS source FINAL
LEFT JOIN analytics.activity_duplicate_groups AS groups FINAL
  ON groups.activity_id = source.activity_id
 AND groups.is_deleted = 0
WHERE source.user_id = toUUID('<user-uuid>')
  AND source.started_at >= toDateTime64('2026-09-01 00:00:00', 6, 'UTC')
  AND source.started_at < toDateTime64('2026-09-02 00:00:00', 6, 'UTC')
  AND source.is_deleted = 0
ORDER BY source.started_at, source.activity_id;
```

## 3. Execute

Re-run the identical bounds and artifact directory with the explicit write flag,
named owner, and deadline:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts \
  --user-id=<user-uuid> \
  --start-at=2026-09-01T00:00:00Z \
  --end-at=2026-09-02T00:00:00Z \
  --batch-size=250 \
  --max-batches=20 \
  --artifact-directory=/secure/dofek/activity-integrity/2026-09-02 \
  --execute \
  --acceptance-owner=<named-operator> \
  --acceptance-deadline=2026-09-02T23:00:00Z
```

The command first persists a `phase: "snapshot"` artifact, applies the
PostgreSQL compare-and-swap update, and atomically records
`phase: "postgres_committed"`. After the CDC readiness barrier, it runs the
seven dbt-owned models with one thread and generic `activity_refresh_user_id`
and `activity_refresh_activity_ids` vars. Each model limits its current rows,
dirty keys, stale-key tombstones, and inserts to the affected key closure;
normal scheduled dbt behavior is unchanged when the vars are absent. Success
atomically records `phase: "executed"`. A caught CDC, dbt, or post-build
verification failure records `phase: "rebuild_failed"`, the failing stage, and
the current seven-model state so rollback remains auditable. The dbt models
remain the owners of incremental analytics transformations; see
[dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

The result reports selected, changed, and updated counts; changed IDs;
before/after component counts; the actual count of members whose canonical
type (or provider for `other`) is incompatible with their canonical activity;
and the artifact path. `updated` must equal `changed`, and the incompatible
member count must be zero. Stop on any error. Do not rerun after a failed
execute: preserve the artifact and inspect its phase before deciding whether
recovery or rollback is appropriate.

## 4. Verify with `FINAL`

Repeat the baseline queries, then run these targeted checks.

The known false Wahoo/Peloton component must be split. Activity `2a7c6fa3-32f1-4ae5-9c99-b981c31e289b`
must not have a Peloton member:

```sql
SELECT
  toString(groups.group_id) AS group_id,
  groupArray((source.provider_id, toString(source.activity_id))) AS sources
FROM analytics.activity_duplicate_groups AS groups FINAL
INNER JOIN analytics.activity_source_records AS source FINAL
  ON source.activity_id = groups.activity_id
WHERE groups.is_deleted = 0
  AND source.is_deleted = 0
  AND groups.group_id = (
    SELECT group_id
    FROM analytics.activity_duplicate_groups FINAL
    WHERE activity_id = toUUID('2a7c6fa3-32f1-4ae5-9c99-b981c31e289b')
      AND is_deleted = 0
  )
GROUP BY groups.group_id;
```

Activity `894ce621-0000-4000-8000-000000000001` must have a named timezone and
offsets consistent with that zone at its start and end instants. The PostgreSQL
invariant query below must return no rows for the repaired window:

```sql
SELECT id, started_at, ended_at, timezone,
  start_utc_offset_minutes, end_utc_offset_minutes
FROM fitness.activity
WHERE user_id = '<user-uuid>'::uuid
  AND started_at >= '2026-09-01T00:00:00Z'::timestamptz
  AND started_at < '2026-09-02T00:00:00Z'::timestamptz
  AND timezone IS NOT NULL
  AND (
    start_utc_offset_minutes IS DISTINCT FROM
      extract(epoch FROM ((started_at AT TIME ZONE timezone) - (started_at AT TIME ZONE 'UTC'))) / 60
    OR (
      ended_at IS NOT NULL
      AND end_utc_offset_minutes IS DISTINCT FROM
        extract(epoch FROM ((ended_at AT TIME ZONE timezone) - (ended_at AT TIME ZONE 'UTC'))) / 60
    )
  );
```

For each changed ID, every applicable Task 3 table must expose the expected
current row under `FINAL` and
the artifact's `execution.highestDerivedVersion` must not be lower than its
captured pre-write version:

```sql
SELECT 'source' AS model, toString(activity_id) AS activity_id, count() AS visible_rows
FROM analytics.activity_source_records FINAL
WHERE activity_id IN (<quoted-activity-uuids>)
GROUP BY activity_id
UNION ALL
SELECT 'groups', toString(activity_id), count()
FROM analytics.activity_duplicate_groups FINAL
WHERE activity_id IN (<quoted-activity-uuids>)
GROUP BY activity_id;
```

Also compare the activity-summary API or MCP response captured before execution.
The expected aggregate effects are directional, not fixed numeric targets:

- `unclassified_pct` may rise when an incorrectly inherited type becomes a
  truthful `other` activity. Treat that as an integrity correction.
- `power_by_modality.unknown.coverage` may rise or otherwise shift as activities
  leave an incorrectly inherited modality. A stratum with fewer than three
  power-bearing activities must keep `avg_power` and `max_power_peak` as `null`.
- Outdoor Wahoo power must remain unavailable when neither the provider payload
  nor sensor samples contain it. This repair must not synthesize power.

The named acceptance owner must record the query results and decide before the
deadline. If any invariant fails, a false component remains, a changed row is
missing under `FINAL`, or the aggregate movement is unexplained, roll back.

## 5. Accept and retire

After all checks pass, the named owner closes the rollback window:

```bash
pnpm tsx scripts/repair-activity-data-integrity.ts \
  --retire-artifact=<artifact-path> \
  --accepted-by=<named-operator> \
  --disposition=accepted
```

The command creates `<artifact-path>.retired.json` with mode `0600` and refuses
an owner mismatch or acceptance after the artifact deadline. Preserve both
files according to the production change-record retention policy. Never edit or
replace either file manually.

## Rollback

Rollback is allowed for a not-retired `postgres_committed`, `rebuild_failed`, or
`executed` artifact. For captured post-build states, the current PostgreSQL and
all seven ClickHouse tables must still match the artifact:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts \
  --rollback-artifact=<artifact-path>
```

The command restores Postgres with compare-and-swap; inserts captured source,
match, group, deduped activity, member, sensor-summary, and summary rows with a
version greater than all captured and currently visible versions; and inserts
tombstones for every after-only key in those seven tables. It verifies both
the restored active rows and the after-only tombstones with `FINAL`, including
source and group rows that are no longer reachable through an active join. A
stale-state error means a later sync or repair changed the scope; stop and
investigate rather than forcing the rollback.

After a successful rollback, the command atomically records
`phase: "rolled_back"` and `rollbackEligibility: "not_applicable"`. Preserve
the artifact as evidence; the original repair is no longer a rollback target.
Do not delete or edit the audit artifact.

## Artifact format and handling

Audit artifacts are UTF-8 JSON, formatted with two-space indentation and a
trailing newline. Timestamps are ISO-8601 UTC strings and ClickHouse `UInt64`
versions are decimal strings so values above JavaScript's safe-integer limit
remain exact. Files are created with exclusive mode `0600`; execute completion
uses a private temporary file followed by `rename`, and retirement uses a new
exclusive sidecar. These operations use the Node.js filesystem APIs documented
for [`writeFile`](https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options)
and [`rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath).

Keep the directory on one durable filesystem, restrict it to the operator, and
never place it in Git, issue attachments, chat, or general-purpose logs because
it contains user activity metadata. The default local
`activity-data-integrity-artifacts/` directory is Git-ignored, but production
operations must always pass an approved durable `--artifact-directory`.
