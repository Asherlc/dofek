# Activity Data Integrity Repair Runbook

Use this runbook to correct contradictory local-time context on a bounded set
of activities and rebuild their derived activity state. This is a manual data
operation, not a deployment step. It changes only `timezone`,
`start_utc_offset_minutes`, `end_utc_offset_minutes`, and
`local_time_source` on `fitness.activity`; it never changes provider identity,
name, raw payloads, metrics, or sensor observations.

## Safety model

- Scope every repair to one user UUID and one explicit half-open UTC window.
  Start with a dry run and the smallest useful window.
- Execute mode requires one named acceptance owner and a deadline within the
  next 24 hours. The artifact is rollback eligible until it is rolled back or
  its owner retires it.
- A PostgreSQL advisory lock and the durable
  `fitness.activity_integrity_repair_journal` provide the global boundary.
  Only one rollback-eligible journal row may exist across all artifact
  directories. PostgreSQL documents session advisory locks in its
  [explicit-locking reference](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
- The repair's local-time compare-and-swap update and its
  `postgres_committed` journal row are one Postgres transaction. A filesystem
  interruption after that transaction does not remove the authoritative
  recovery record. See PostgreSQL's [transaction](https://www.postgresql.org/docs/current/tutorial-transactions.html)
  and [`UPDATE`](https://www.postgresql.org/docs/current/sql-update.html)
  documentation.
- Every visible ClickHouse verification query uses `FINAL`. The rebuild itself
  remains dbt-owned; the command does not insert, restore, or tombstone
  ClickHouse rows directly. dbt documents its ownership and incremental
  execution model in its [incremental-model guide](https://docs.getdbt.com/docs/build/incremental-models).

Do not begin another historical repair while a journal row is eligible. Do not
force a failed CAS or a CDC timeout: preserve the artifact and investigate the
specific journal phase.

## Preconditions

1. Confirm `DATABASE_URL` and `CLICKHOUSE_URL` point at the intended
   environment. Never copy either value into an artifact or change record.
2. Choose a narrow user/window scope. `--start-at` is inclusive and `--end-at`
   is exclusive.
3. Create an approved durable artifact directory outside the repository. The
   command creates directories with mode `0700` and JSON files with mode
   `0600`.
4. Identify the acceptance owner and deadline. The same individual must be
   available to verify, roll back, or retire the repair.

## 1. Dry run

Run through the repository environment wrapper without `--execute`:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts \
  --user-id=<user-uuid> \
  --start-at=2026-09-01T00:00:00Z \
  --end-at=2026-09-02T00:00:00Z \
  --batch-size=250 \
  --max-batches=20 \
  --artifact-directory=/secure/dofek/activity-integrity/2026-09-02
```

Confirm the JSON result reports `kind: "dry-run"` and `updated: 0`. Inspect
the artifact without editing it:

- `userId`, window, selection bound, and `changedActivityIds` are exact;
- each `postgresActivities[].prior` to `.repaired` local-time transition is
  explainable from the provider timezone or offset;
- the captured component closure and eight derived projections are expected;
  and
- `incompatibleMemberCount` is zero or has an explicit investigation plan.

Stop and narrow the input if the selection reaches `batchSize * maxBatches`,
an unrelated activity appears, or any proposed change is unexplained.

## 2. Execute

Re-run the exact bounds with the named owner and deadline:

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

The command writes a private snapshot, then atomically applies the
Postgres local-time CAS and creates a `postgres_committed` journal row. It
waits for the exact changed local-time fields in the ClickHouse Postgres mirror
before rebuilding the bounded eight-model dbt scope. On success the journal is
`executed`; a CDC, dbt, or verification failure records `rebuild_failed` and
remains a rollback target.

Do not rerun a failed execute. Preserve the artifact and use
`--rollback-artifact=<artifact-path>` to restore the captured local-time state.

## 3. Verify

Check the result JSON: `updated` must equal `changed`, every changed ID must be
expected, and the reported incompatible-member count must be zero. Save the
change record with focused `FINAL` results for the affected activities from all
eight projections:

- `activity_source_records`
- `activity_duplicate_matches`
- `activity_duplicate_groups`
- `deduped_activities`
- `deduped_activity_members`
- `activity_sensor_sample`
- `activity_sensor_summary_rows`
- `activity_summary_rows`

For example, inspect the visible source and group state:

```sql
SELECT
  toString(source.activity_id) AS activity_id,
  source.provider_id,
  source.timezone,
  source.start_utc_offset_minutes,
  source.end_utc_offset_minutes,
  source.local_time_source,
  toString(groups.group_id) AS group_id
FROM analytics.activity_source_records AS source FINAL
LEFT JOIN analytics.activity_duplicate_groups AS groups FINAL
  ON groups.activity_id = source.activity_id
 AND groups.is_deleted = 0
WHERE source.user_id = toUUID('<user-uuid>')
  AND source.activity_id IN (<quoted-affected-activity-uuids>)
  AND source.is_deleted = 0
ORDER BY source.activity_id;
```

Confirm the intended false component is split, valid duplicate edges remain,
and downstream canonical/member/summary IDs agree. If a later provider update
arrives during this window, record it; it is not a reason to overwrite
provider-owned fields.

## 4. Accept and retire

After verification, the named owner closes the rollback window:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts \
  --retire-artifact=<artifact-path> \
  --accepted-by=<named-operator> \
  --disposition=accepted
```

Retirement first atomically persists the owner, disposition, timestamp,
receipt path, and receipt checksum in the journal and changes its phase to
`retired`. Only then does it create `<artifact-path>.retired.json`. This means
the receipt is a materialization of the durable decision, not its authority.

If the command reports a filesystem error after retirement, rerun **the exact
same** retirement command. It materializes or verifies the same receipt without
reopening rollback eligibility. A different owner or disposition conflicts
with the durable decision and must not be retried with different arguments.
Keep the artifact and receipt together; never edit either file manually.

## Rollback

Rollback is available for a journal in `postgres_committed`, `rebuild_failed`,
`executed`, or `rollback_committed`, but never after retirement:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts \
  --rollback-artifact=<artifact-path>
```

Rollback performs a user-scoped compare-and-swap only on the four captured
local-time columns. It never restores provider-owned name, raw payload, or
other fields. If the captured repaired local-time values no longer match,
rollback fails loudly rather than overwriting a later local-time update.

After the Postgres rollback transaction commits, the command waits for the
restored fields in the ClickHouse Postgres mirror and then runs the same bounded
eight-model dbt rebuild. It verifies the resulting source state through
`FINAL`, records `rolled_back`, and ends rollback eligibility. No direct
ClickHouse snapshot restoration, stale-row comparison, or tombstone operation
is part of this protocol.

## Artifact handling

Artifacts contain user activity metadata. Keep them on one durable,
access-controlled filesystem, outside Git, issue attachments, chat, and
general-purpose logs. JSON artifacts and receipts are UTF-8 with two-space
indentation, a trailing newline, ISO-8601 UTC timestamps, and exclusive mode
`0600`; filesystem operations use Node's documented
[`writeFile`](https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options)
and [`rename`](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath).

The default local `activity-data-integrity-artifacts/` directory is Git-ignored.
Production operations must pass an approved durable `--artifact-directory`.
