# Activity power curve memory-bounded rebuild

## Problem

`analytics.activity_power_curve` intermittently fails with ClickHouse exception
241 (`MEMORY_LIMIT_EXCEEDED`) during its incremental `INSERT`. On 2026-09-16 at
14:06 and 14:22 UTC the model failed after ~107 s and ~136 s with a peak of
7.8–8.7 GiB while reading 86–93M rows. Later cycles passed with no code change,
so the failure is a peak-memory race, not a deterministic error.

Tracked as [#2762](https://github.com/Asherlc/dofek/issues/2762).

## Root cause

Two independent memory blow-ups combine in one query.

### 1. O(N²) correlated array indexing (primary)

`power_sample_segments` computes the gap between consecutive samples with:

```sql
arrayMap(
    sample_index -> dateDiff(
        'millisecond',
        recorded_times[sample_index],
        recorded_times[sample_index + 1]
    ) / 1000.0,
    arrayEnumerate(arrayPopBack(recorded_times))
) AS segment_seconds
```

Indexing the closed-over `recorded_times` array from inside the `arrayMap`
lambda makes ClickHouse replicate that array per element. The stack ends at
`FunctionArrayMapped<ArrayMapImpl>` → `ColumnArray::replicateGeneric` →
`ColumnDecimal<DateTime64>::insertRangeFrom` → a multi-GiB `PODArray` growth.

Measured on production with a synthetic 14,000-sample array: the correlated
form used **1.50 GiB and hit the limit** (would have used 3 GiB, allocating a
2 GiB chunk). A 14,299-sample activity alone is enough to OOM the query, which
is why the failures were intermittent and batch-dependent.

### 2. `FINAL` merging every channel (secondary)

`power_sample_groups` read the samples as:

```sql
FROM activity_bounds AS am
INNER JOIN {{ ref('activity_sensor_sample') }} AS sensor FINAL
    ON sensor.activity_id = am.activity_id
    AND sensor.user_id = am.user_id
    AND sensor.channel = 'power'
    ...
```

`activity_sensor_sample` holds **94.7M rows across 645 active parts** (2.79M
are `channel = 'power'`). Because `channel = 'power'` was only a JOIN `ON`
predicate, ClickHouse deduped every channel before filtering, so the `FINAL`
merge state spanned the batch's whole key range. For a 32-key batch this read
cost 9.7M rows and ~396 MiB; for the batches that failed it reached ~93M rows.

## Fix

### 1. Segment duration without correlated indexing

```sql
arrayMap(
    (start_recorded_at, end_recorded_at) -> dateDiff(
        'millisecond',
        start_recorded_at,
        end_recorded_at
    ) / 1000.0,
    arrayPopBack(recorded_times),
    arrayPopFront(recorded_times)
) AS segment_seconds
```

The two-argument `arrayMap` over `arrayPopBack`/`arrayPopFront` passes adjacent
elements as lambda arguments, so nothing is indexed inside the lambda. It is
arithmetically identical to the original (`dateDiff('millisecond', …) / 1000.0`
on each adjacent pair) and is O(N). On the same 14,000-sample array: **599 KiB
and 4 ms**.

### 2. Channel filter as `PREWHERE`

```sql
activity_power_samples AS (
    SELECT
        activity_id, user_id, recorded_at, scalar, provider_id, device_id, measurement_kind
    FROM {{ ref('activity_sensor_sample') }} FINAL
    PREWHERE channel = 'power'
    WHERE is_deleted = 0
        AND scalar >= 0
        AND (user_id, activity_id) IN (
            SELECT user_id, activity_id FROM activity_bounds
        )
),
```

`channel` is part of the `ReplacingMergeTree` sort key, so filtering it before
`FINAL` removes only keys irrelevant to this model and is result-preserving.
`is_deleted` and `scalar` are payload columns and stay **after** `FINAL`; moving
`is_deleted` earlier could resurrect an older non-deleted version.

## Verification

Production read-only benchmarks (32 keys, `max_threads = 1`):

| Measurement | Before | After |
| --- | --- | --- |
| Correlated segment arrayMap, 14k samples | 1.50 GiB (failed) | 599 KiB |
| Read only, 32 largest activities | 747 MiB / 42.1 s | 89.6 MiB / 1.8 s |
| Full model, 32 largest activities | >6 GiB (failed) | **405 MiB / 14.8 s** |
| Full model, normal incremental batch | — | 65.5 MiB / 4.3 s |

Output rows are identical before and after (217,510 power samples, 32
activities).

## Testing

- `analytics/models/read_models/activity_power_curve.sql.test.ts` asserts the
  shifted `arrayMap` form and that `recorded_times[` no longer appears, plus the
  `PREWHERE channel = 'power'` / post-`FINAL` `is_deleted` contract.
- `src/db/activity-power-curve-read-model.integration.test.ts` runs the model
  against a real ClickHouse fixture with mixed channels, duplicate versions, a
  soft-deleted latest version, and negative power, and asserts the exact output.
  It fails if the channel filter is removed or a deleted latest version is
  resurrected.

## Out of scope

- Bounding the dirty-key batch by sample volume: not needed once the O(N²)
  allocation is removed; the 32-key cap already bounds a cycle.
- Rewriting the 17-duration window expansion: total memory is now well under
  the ceiling.
