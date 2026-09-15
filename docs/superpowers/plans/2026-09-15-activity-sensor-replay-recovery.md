# Activity Sensor Replay Recovery Implementation Plan

**Goal:** Restore healthy recurring activity analytics and repair the September 13 activity-sensor batch without increasing production resource or health budgets.

**Architecture:** Resolve `ReplacingMergeTree` inputs to logical current state, stream active associations directly through the bounded activity-day join, and derive stale tombstones by negating the same membership predicate. Keep routine work to the previous and current ingestion-freshness days; run September 13 once through dbt's explicit bounded backfill interface.

**Tech Stack:** dbt Core 1.11, dbt-clickhouse, ClickHouse 26.8, SQL/Jinja, TypeScript, Vitest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-15-activity-sensor-replay-recovery-design.md`

## Global Constraints

- Preserve active rows and explicit tombstones at `(activity_id, channel, recorded_at)` grain.
- Read sensor analytics from deduplicated ClickHouse state, never raw `ingest.metric_stream`.
- Do not add or enlarge memory, timeout, retry, startup, or health settings.
- Historical repair must have explicit start and end bounds and remain outside scheduled code.
- Use executable ClickHouse integration tests; do not substitute SQL-string assertions for database behavior.
- Do not add a schema migration, projection, index, feature flag, or incident-specific runtime branch.
- Use one dbt/ClickHouse thread for production analytics work.

---

### Task 1: Prove and implement logical current-state reconciliation

**Files:**
- Modify: `src/db/activity-sensor-sample-read-model.integration.test.ts`
- Modify: `src/db/activity-payload-dbt-microbatch.integration.test.ts`
- Modify: `analytics/models/read_models/activity_sensor_sample.sql`
- Modify: `analytics/models/read_models/read_model_microbatch.sql.test.ts`

**Interfaces:**
- Consumes: `deduped_sensor` logical rows keyed by `(user_id, channel, recorded_at)` and `deduped_activities` logical rows keyed by activity group.
- Produces: active or deleted `activity_sensor_sample` rows keyed by `(activity_id, channel, recorded_at)`.

- [ ] **Step 1: Tighten the real-engine tests before changing SQL**

In `activity-sensor-sample-read-model.integration.test.ts`, change the independently derived join expectation from the old two-stage join to the intended single activity-window join:

```ts
const expectedMatchCount = activityCount + 2;
const expectedJoinResultCount = expectedMatchCount;
```

In `activity-payload-dbt-microbatch.integration.test.ts`, rename the physical-version case and make it assert one inserted logical row. Select the latest insert by stable target/query-kind criteria rather than the removed CTE name:

```ts
it("maps the latest logical sensor version to activity membership once", async () => {
  // existing fixture and two unmerged source-version inserts remain unchanged
  const result = await client.query({
    query: `SELECT written_rows
      FROM system.query_log
      WHERE type = 'QueryFinish'
        AND query_kind = 'Insert'
        AND query LIKE '%${database}%activity_sensor_sample%'
      ORDER BY event_time_microseconds DESC
      LIMIT 1`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual([{ written_rows: 1 }]);
});
```

- [ ] **Step 2: Run both tests and verify the intended red state**

Run:

```sh
rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-sensor-sample-read-model.integration.test.ts'
rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts -t "maps the latest logical sensor version to activity membership once"'
```

Expected: the first test reports the old doubled `JoinResultRowCount`; the second reports `written_rows: 2` instead of `1`.

- [ ] **Step 3: Replace the high-cardinality membership intermediates**

In `activity_sensor_sample.sql`, set model query settings to:

```jinja
query_settings={
    'max_threads': 1,
    'join_use_nulls': 1,
    'final': 1
}
```

Keep `batch_samples` streaming:

```sql
WITH batch_samples AS (
    SELECT *
    FROM {{ ref('deduped_sensor') }}
),
```

Delete `batch_sample_keys`, `activity_sample_membership`, and the payload rejoin. Replace them with one direct current-state join:

```sql
activity_samples AS (
    SELECT
        activity_days.activity_id AS activity_id,
        samples.user_id AS user_id,
        samples.recorded_at AS recorded_at,
        samples.recorded_date AS recorded_date,
        samples.channel AS channel,
        samples.scalar AS scalar,
        samples.provider_id AS provider_id,
        samples.member_activity_id AS member_activity_id,
        samples.device_id AS device_id,
        samples.source_external_id AS source_external_id,
        samples.source_type AS source_type,
        samples.source_metric_stream_id AS source_metric_stream_id,
        samples.measurement_kind AS measurement_kind,
        samples.is_deleted AS is_deleted,
        greatest(samples.refreshed_at, activity_days.source_synced_at) AS source_refreshed_at
    FROM batch_samples AS samples
    INNER JOIN activity_days
        ON activity_days.user_id = samples.user_id
        AND activity_days.recorded_date = samples.recorded_date
        AND samples.recorded_at >= activity_days.started_at
        AND samples.recorded_at <= activity_days.effective_ended_at
        AND (
            samples.source_activity_id IS null
            OR has(activity_days.member_activity_ids, assumeNotNull(samples.source_activity_id))
        )
    WHERE samples.is_deleted = 0
),
```

Replace incremental stale discovery with a direct logical-key join and exact invalidation predicate:

```sql
stale_activity_samples AS (
    SELECT
        existing_samples.activity_id AS stale_activity_id,
        existing_samples.user_id AS stale_user_id,
        existing_samples.recorded_at AS stale_recorded_at,
        existing_samples.recorded_date AS stale_recorded_date,
        existing_samples.channel AS stale_channel,
        existing_samples.scalar AS stale_scalar,
        existing_samples.provider_id AS stale_provider_id,
        existing_samples.member_activity_id AS stale_member_activity_id,
        existing_samples.device_id AS stale_device_id,
        existing_samples.source_external_id AS stale_source_external_id,
        existing_samples.source_type AS stale_source_type,
        existing_samples.source_metric_stream_id AS stale_source_metric_stream_id,
        existing_samples.measurement_kind AS stale_measurement_kind,
        greatest(existing_samples.refreshed_at, activity_group_state.refreshed_at) AS stale_refreshed_at
    FROM {{ this }} AS existing_samples
    INNER ANY JOIN batch_samples AS samples
        ON samples.user_id = existing_samples.user_id
        AND samples.channel = existing_samples.channel
        AND samples.recorded_at = existing_samples.recorded_at
    INNER JOIN activity_group_state
        ON activity_group_state.group_activity_id = existing_samples.activity_id
        AND activity_group_state.user_id = existing_samples.user_id
    WHERE existing_samples.is_deleted = 0
      AND (
          samples.is_deleted = 1
          OR activity_group_state.is_deleted = 1
          OR samples.recorded_at < activity_group_state.started_at
          OR samples.recorded_at > activity_group_state.effective_ended_at
          OR (
              samples.source_activity_id IS NOT null
              AND NOT has(
                  activity_group_state.member_activity_ids,
                  assumeNotNull(samples.source_activity_id)
              )
          )
      )
)
```

The model-level `final=1` setting applies `FINAL` to the source, activity, and existing-target `ReplacingMergeTree` reads.

- [ ] **Step 4: Adapt the existing SQL policy test to the new production contract**

Rename the activity-sensor case to `reconciles logical current-state activity sensor samples`. Retain its model/config, projection, ref, activity-day, source-freshness, and output assertions. Replace assertions tied to materialized membership/version joins with positive assertions for `'final': 1`, `INNER ANY JOIN batch_samples AS samples`, and each stale predicate. Update the source-freshness assertion to:

```ts
expect(activitySensorSampleSql).toContain(
  "greatest(samples.refreshed_at, activity_days.source_synced_at) AS source_refreshed_at",
);
```

- [ ] **Step 5: Re-run the focused tests and verify green**

Run the two Step 2 commands again.

Expected: both pass; the join profile equals the number of logical associations and the unmerged source versions yield one inserted target row.

- [ ] **Step 6: Run the complete activity payload reconciliation suite**

Run:

```sh
rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts src/db/activity-sensor-sample-read-model.integration.test.ts src/db/activity-group-payload-union.integration.test.ts'
```

Expected: all active/tombstone, group-move, overlap, linked/ambient, and cross-midnight cases pass.

- [ ] **Step 7: Commit and push the tested query change**

```sh
rtk git add analytics/models/read_models/activity_sensor_sample.sql analytics/models/read_models/read_model_microbatch.sql.test.ts src/db/activity-sensor-sample-read-model.integration.test.ts src/db/activity-payload-dbt-microbatch.integration.test.ts
rtk git commit -m "Reconcile activity sensors from current state"
rtk git push
```

---

### Task 2: Bound recurring freshness replay

**Files:**
- Modify: `analytics/models/staging/sensor_scalar_sample.sql`
- Modify: `analytics/models/read_models/deduped_sensor.sql`
- Modify: `analytics/models/read_models/activity_sensor_sample.sql`
- Modify: `analytics/models/read_models/read_model_microbatch.sql.test.ts`
- Modify: `analytics/README.md`

**Interfaces:**
- Consumes: daily ingestion/source freshness event times.
- Produces: previous-day plus current-day recurring dbt batches; older dates remain available through explicit dbt event-time bounds.

- [ ] **Step 1: Change all three daily microbatch lookbacks from `3` to `1`**

Apply the same steady-state value in `sensor_scalar_sample.sql`, `deduped_sensor.sql`, and `activity_sensor_sample.sql`:

```jinja
lookback=1,
```

Remove the obsolete exact `lookback=3` source-text assertion from `read_model_microbatch.sql.test.ts`. Do not replace it with a static-config value test; dbt parse/compile and production batch logs validate this declarative setting.

- [ ] **Step 2: Update the analytics architecture and recovery documentation**

In `analytics/README.md`, state that the three freshness-based models process the previous and current day during routine cycles, that newly ingested historical measurements receive current ingestion freshness, and that older freshness windows require explicit bounded `--event-time-start` and `--event-time-end` operation. Link the claim to dbt's microbatch backfill documentation already used in that section.

- [ ] **Step 3: Validate model parsing, SQL policy, and affected unit coverage**

Run:

```sh
rtk pnpm lint:analytics-sql
rtk pnpm lint:analytics-policy
rtk pnpm vitest run --project unit analytics/models/read_models/read_model_microbatch.sql.test.ts
rtk bash -lc 'set -a; . ./.env.local; set +a; UV_PROJECT_ENVIRONMENT=../.venv-analytics uv run --project analytics dbt parse --project-dir analytics --profiles-dir analytics --target dev'
```

Expected: all commands exit zero with no parsing or policy errors.

- [ ] **Step 4: Commit and push the replay-policy change**

```sh
rtk git add analytics/models/staging/sensor_scalar_sample.sql analytics/models/read_models/deduped_sensor.sql analytics/models/read_models/activity_sensor_sample.sql analytics/models/read_models/read_model_microbatch.sql.test.ts analytics/README.md
rtk git commit -m "Bound recurring sensor freshness replay"
rtk git push
```

---

### Task 3: Complete repository verification and delivery

**Files:**
- Delete: `.tmp-activity-sensor-direct-state-benchmark.sql`
- Delete: `.tmp-activity-sensor-hybrid-benchmark.sql`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: a reviewable branch with no diagnostic artifacts and a normal deployable PR.

- [ ] **Step 1: Remove the two throwaway benchmark SQL files**

Use `apply_patch` to delete only the two `.tmp-activity-sensor-*.sql` files. Preserve `.pnpm-store/`.

- [ ] **Step 2: Run full proportional verification**

Run:

```sh
rtk pnpm typecheck
rtk pnpm lint:analytics-sql
rtk pnpm lint:analytics-policy
rtk pnpm test:changed
rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts src/db/activity-sensor-sample-read-model.integration.test.ts src/db/activity-group-payload-union.integration.test.ts'
```

Expected: every command passes without skipped gates or ad-hoc resource settings.

- [ ] **Step 3: Review the branch diff and push any verification-only corrections**

Run `rtk git diff --check`, inspect `rtk git diff origin/main...HEAD`, and ensure `rtk git status --short` contains only the preserved `.pnpm-store/`. Commit and push any required correction before opening the PR.

- [ ] **Step 4: Open the PR and monitor CI through completion**

Use the repository `ship-pr` workflow. Link the September 13 OOM evidence and the two read-only benchmark results in the PR body. Do not merge until required checks pass.

- [ ] **Step 5: Merge and monitor the canonical deployment**

Merge through GitHub after required checks pass. Monitor the canonical deploy workflow and Swarm rollout; do not use `docker service update`, a manual stack deploy, or a timeout/retry change.

---

### Task 4: Execute bounded production recovery and close the incident

**Files:**
- Modify after verification: `docs/production-incident-baseline.md`

**Interfaces:**
- Consumes: the deployed current-state query and one-day replay policy.
- Produces: repaired September 13 activity sensor state, two healthy worker cycles, and durable incident evidence.

- [ ] **Step 1: Verify the first deployed recurring cycle**

Use bounded Swarm logs and `system.query_log` to confirm each of the three sensor microbatch models schedules only the previous and current UTC days, every selected model passes, and the worker records a successful cycle without ClickHouse code 241.

- [ ] **Step 2: Resolve the active worker container during its normal sleep interval**

Read the single running `dofek_analytics-worker` task/container ID and verify `system.processes` has no dbt query. Do not change the service replica count or specification.

- [ ] **Step 3: Run the one bounded September 13 model repair**

Inside the resolved production analytics-worker container, run:

```sh
dbt run --project-dir analytics --profiles-dir analytics --threads 1 --event-time-start "2026-09-13" --event-time-end "2026-09-14" --select "activity_sensor_sample"
```

This uses the deployed image and existing production environment. Monitor ClickHouse throughout; stop and preserve the first fatal line if memory pressure or another failure appears. Do not add a query timeout or memory override.

- [ ] **Step 4: Validate repaired data and two complete cycles**

Confirm the bounded model reports success, inspect `system.query_log` for duration/read/peak-memory/written-row evidence, and compare `activity_sensor_sample FINAL` active/tombstone state with current `deduped_sensor FINAL` and `deduped_activities FINAL`. Then require two consecutive complete worker cycles and current downstream activity-summary maxima.

- [ ] **Step 5: Confirm the user-visible outcome**

Verify activities after September 9 remain present through the production serving query/UI and that downstream activity sensor analytics are no longer stalled.

- [ ] **Step 6: Record and deliver the final incident baseline**

Append the date, symptom, impact, exact fatal line, root cause, deployed fix, bounded backfill evidence, two-cycle validation, remaining risk, and follow-up recommendation to `docs/production-incident-baseline.md`. Commit, push, open/merge the documentation PR through normal CI, and include the final evidence in the incident handoff.
