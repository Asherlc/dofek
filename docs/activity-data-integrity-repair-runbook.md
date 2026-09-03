# Activity Data Integrity Repair Runbook

Use this runbook to correct contradictory local-time context and Strong
wall-clock timestamps on a bounded set of activities, then rebuild their
derived activity state. This is a manual data operation, not a deployment
step. It changes only `started_at`, `ended_at`, the resolved local-time fields,
and the three `rejected_provider_*` audit fields on `fitness.activity`; it never
changes provider identity, name, raw payloads, metrics, or sensor observations.

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
3. Resolve a bare MCP activity-ID prefix to exactly one user before running the
   inspector or repair:

   ```sql
   SELECT DISTINCT activity.user_id
   FROM fitness.activity AS activity
   WHERE activity.id::text LIKE '<activity-id-prefix>%';
   ```

   Stop if the query returns zero users or more than one user. Never infer the
   user from provider metadata.
4. Verify that `fitness.user_settings` contains the `homeTimezone` key for the
   user. GPS-derived
   timezone evidence takes precedence for an activity that has coordinates;
   otherwise the repair uses the configured home zone. The preflight hard-fails
   when neither exists. Expected UTC offsets are resolved from that zone at the
   activity instant, including daylight-saving changes; they are never compared
   with a fixed `-420` or `-480` value. JavaScript's `Intl.DateTimeFormat`
   accepts IANA timezone names and applies their rules at the formatted instant;
   see [MDN's `timeZone` option reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat#timezone).
5. Create an approved durable artifact directory outside the repository. The
   command creates directories with mode `0700` and JSON files with mode
   `0600`.
6. Identify the acceptance owner and deadline. The same individual must be
   available to verify, roll back, or retire the repair.

## 1. Dry run

### Retry a retained failed Strong import

If the diagnosis found a failed Strong import with a retained source object,
repair it before the derived-state dry run. This is a normal replay of the
immutable provider export through the current transactional importer; it does
not edit provider payloads or raw sensor observations in place.

First verify the retained object and corrected parsing metadata without
queueing work:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/retry-failed-file-upload.ts \
  --upload-id=<failed-upload-uuid> \
  --user-id=<user-uuid> \
  --weight-unit=lbs \
  --timezone=America/Los_Angeles
```

Confirm `kind: "dry-run"`, the expected import type and byte count, and the
corrected unit and timezone. Then queue the exact retry with a stable job ID:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/retry-failed-file-upload.ts \
  --upload-id=<failed-upload-uuid> \
  --user-id=<user-uuid> \
  --weight-unit=lbs \
  --timezone=America/Los_Angeles \
  --job-id=file-import-repair-<date>-strong \
  --execute
```

Wait for the upload to reach `completed`. Report strength activity and set
counts before and after, and verify that the cited deadlift session has sets,
weights are kilograms, rest entries use `setType: "rest"`, and set indices are
sequential. If the object is absent, deleted, has a different byte
count, or the retry fails, stop. Obtain a fresh upload from the user rather
than reconstructing provider data.

The Strong replay corrects provider-derived activity rows and strength sets.
The single historical repair below remains the only operation that rewrites
the overlapping local-time fields and rebuilds the derived ClickHouse models.

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
- each `postgresActivities[]` timestamp and local-time transition is explainable
  from GPS or the configured home zone, and every rejected provider value is
  retained in the row's `rejected_provider_*` fields;
- the captured component closure and eight derived projections are expected;
  and
- `incompatibleMemberCount` is zero or has an explicit investigation plan.

Stop and narrow the input if the selection reaches `batchSize * maxBatches`,
an unrelated activity appears, or any proposed change is unexplained.

For the September 2026 combined repair, use one window covering the complete
Strong export history as well as the September fixtures. The reviewed dry run must report 79
offset-plausibility failures (75 stored at `-240`, four at `-300`), the two
representative-selection groups containing six source rows, zero containment
groups, the `2a7c6fa3` summary refresh, and every Strong timestamp in the
bounded window either already corrected by the retained replay or proposed for
timezone-aware correction from legacy `unknown` context. A Strong row that
already carries valid timezone context must retain its UTC timestamp. Do not execute separate offset, representative, speed, or
Strong repairs: they intentionally share one audit and rollback point.

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

The command writes a private snapshot, then atomically applies the Postgres
timestamp/local-time CAS and creates a `postgres_committed` journal row. It
waits for the exact changed timestamps, resolved context, and rejected-value
audit fields in the ClickHouse Postgres mirror before rebuilding the bounded
eight-model dbt scope. On success the journal is
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

Confirm valid duplicate edges remain and downstream canonical/member/summary
IDs agree. In the September 2026 repair, the Peloton member of `2a7c6fa3` is a
valid metadata mirror and must remain in `source_providers`; this repair does
not change `activity_duplicate_matches.sql`. Confirm `b20988c5` and `40e593c7`
select the specific `cycling` / `commuting` evidence, and confirm `2a7c6fa3`
refreshes to the RideWithGPS moving-speed values (about 5.568 m/s average and
16.54 m/s maximum). If a later provider update arrives during this window,
record it; it is not a reason to overwrite provider-owned fields.

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

Rollback performs a user-scoped compare-and-swap only on the captured
timestamps, resolved local-time context, and rejected-provider audit fields. It
never restores provider-owned name, raw payload, metrics, or sensor samples. If
the captured repaired values no longer match, rollback fails loudly rather
than overwriting a later provider update.

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
