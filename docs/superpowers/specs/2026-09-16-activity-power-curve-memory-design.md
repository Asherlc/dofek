# Activity power curve memory-bounded sensor read

## Problem

`analytics.activity_power_curve` intermittently fails with ClickHouse exception
241 (`MEMORY_LIMIT_EXCEEDED`) during its incremental `INSERT`. On 2026-09-16 at
14:06 and 14:22 UTC the model failed after ~107 s and ~136 s with a peak of
7.8–8.7 GiB while reading 86–93M rows. The stack ends at
`ColumnDecimal<DateTime64>::insertRangeFrom` in the memory tracker. Later
cycles passed with no code change, so the failure is a peak-memory race, not a
deterministic error.

The same failure mode is tracked as
[#2762](https://github.com/Asherlc/dofek/issues/2762).

## Root cause

`power_sample_groups` reads the per-activity sensor samples as:

```sql
FROM activity_bounds AS am
INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor FINAL
    ON sensor.activity_id = am.activity_id
    AND sensor.user_id = am.user_id
    AND sensor.channel = 'power'
    AND sensor.scalar >= 0
    AND sensor.is_deleted = 0
```

`activity_sensor_sample` is a `ReplacingMergeTree` ordered by
`(user_id, activity_id, recorded_date, channel, recorded_at)` and holds
**94.7M rows across 645 active parts** (2.79M are `channel = 'power'`). Because
`channel = 'power'` is only a JOIN `ON` predicate, ClickHouse evaluates `FINAL`
(dedup) before it, so the merge state spans every channel in the batch's key
ranges. For a 32-key batch this read costs 9.7M rows and ~396 MiB; for the
larger batches that failed it reached ~93M rows and multiple GiB, which with
the downstream 17-duration window expansion exceeded the container memory
ceiling (`max_memory_usage = 0`, no external spilling, ~13 GB cgroup).

Measured on production, a 32-key batch:

| Shape | rows read | peak mem | duration |
| --- | --- | --- | --- |
| Current (channel filter in JOIN) | 9.67M | 396 MiB | 14.4 s |
| `PREWHERE channel = 'power'` + key `IN` | 9.67M | 26.7 MiB | 1.7 s |

Output is identical (80,729 power rows, 32 activities) in both shapes.

## Fix

Read the power samples through a subquery that applies `channel = 'power'` as
`PREWHERE` (before `FINAL`) while keeping `is_deleted`, `scalar`, and the
activity-key filter after `FINAL`:

```sql
activity_power_samples AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        scalar,
        provider_id,
        device_id,
        measurement_kind
    FROM {{ ref('activity_sensor_sample') }} FINAL
    PREWHERE channel = 'power'
    WHERE is_deleted = 0
        AND scalar >= 0
        AND (user_id, activity_id) IN (
            SELECT user_id, activity_id FROM activity_bounds
        )
),

power_sample_groups AS (
    SELECT
        am.activity_id,
        am.user_id,
        am.started_at,
        arraySort(sample -> sample.1, groupArray((
            sensor.recorded_at,
            toFloat64(assumeNotNull(sensor.scalar)),
            sensor.provider_id,
            ifNull(sensor.device_id, ''),
            sensor.measurement_kind
        ))) AS samples
    FROM activity_bounds AS am
    INNER JOIN activity_power_samples AS sensor
        ON sensor.activity_id = am.activity_id
        AND sensor.user_id = am.user_id
    GROUP BY am.activity_id, am.user_id, am.started_at
)
```

### Why `PREWHERE channel = 'power'` is safe

`channel` is part of the `ReplacingMergeTree` sort key, so rows of different
channels are distinct dedup keys. Filtering non-power rows before `FINAL` only
removes keys that are irrelevant to this model; every power version is retained
for dedup.

### Why the other predicates stay after `FINAL`

`is_deleted` and `scalar` are payload columns. Filtering `is_deleted = 0`
before `FINAL` could drop the current deleted version of a key and resurrect an
older non-deleted version, changing results. They must remain after `FINAL`.

## Testing

Add an executable ClickHouse regression (the repository requires database
behavior tests, not static-SQL assertions) that seeds
`activity_sensor_sample` with mixed channels, duplicate versions, a
soft-deleted latest version, and negative power, then asserts the model's
computed power samples match the expected values: only `power` rows, only the
latest version per key, soft-deleted keys excluded, and negative scalars
dropped. Keep the existing static contract assertions in
`analytics/models/read_models/activity_power_curve.sql.test.ts`, updating only
the ones that reference the old JOIN shape.

## Verification before deploy

Run the rewritten read-only sensor query against the worst-case 32-key batch on
production with an explicit `max_memory_usage` cap and confirm the peak stays
well under the ceiling before shipping.

## Out of scope

- Bounding the dirty-key batch by sample volume: deferred unless the production
  benchmark shows insufficient headroom.
- Rewriting the 17-duration window expansion: larger change, not warranted by
  the current evidence.
