# Activity Stream Points And Heart-Rate Zones Read Model Design

## Goal

Activity detail pages can be slow when `activity.stream` assembles and downsamples raw sensor samples at request time. Add a proactive ClickHouse read model that stores the activity-level stream payload used by the API, so common detail-page loads read one precomputed row instead of scanning raw stream data.

`activity.hrZones` can have the same request-time problem when it calculates time in heart-rate zones from raw heart-rate samples. Add a separate proactive ClickHouse read model for heart-rate zone totals rather than mixing aggregate zone data into the stream-points payload.

## Approved Approach

Create two dbt-owned incremental ClickHouse models:

- `analytics.activity_stream_points`
- `analytics.activity_heart_rate_zones`

`activity_stream_points` stores one row per `(user_id, activity_id)` with a downsampled stream payload. `activity_heart_rate_zones` stores one row per `(user_id, activity_id)` with exact time-in-zone totals computed from full-resolution heart-rate samples. These are serving tables, not new canonical sources of truth. Raw sensor data remains canonical in the existing raw/deduped stream models.

dbt incremental models are designed to transform only new or changed data instead of rebuilding the whole table on each run, which matches this proactive cache use case. Source: <https://docs.getdbt.com/docs/build/incremental-models>.

## Stream Points Table Shape

```sql
analytics.activity_stream_points
(
  user_id UUID,
  activity_id UUID,

  points Array(Tuple(
    recorded_at DateTime64(6, 'UTC'),
    heart_rate Nullable(Float64),
    power Nullable(Float64),
    speed Nullable(Float64),
    cadence Nullable(Float64),
    altitude Nullable(Float64),
    lat Nullable(Float64),
    lng Nullable(Float64)
  )),

  refresh_version UInt64
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)
```

## Heart-Rate Zones Table Shape

```sql
analytics.activity_heart_rate_zones
(
  user_id UUID,
  activity_id UUID,

  zones Array(Tuple(
    zone UInt8,
    seconds UInt32
  )),

  refresh_version UInt64
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)
```

ClickHouse `ReplacingMergeTree` supports inserting newer copies of a row and using a version column to identify the latest version during replacement. Source: <https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree>.

## YAGNI Decisions

Do not add `point_count`, `source_sample_count`, `first_recorded_at`, `last_recorded_at`, `is_deleted`, `refreshed_at`, zone threshold metadata, or per-zone flat columns in the first version.

Reasons:
- `point_count` is derivable from `length(points)`.
- sample counts and first/last timestamps are debugging metadata, not required to serve the UI.
- zone threshold metadata is not needed by the API response if the model returns the same zone/seconds shape currently produced by `activity.hrZones`.
- per-zone columns make the table wider without improving the current API.
- deleted activity access should already be blocked by activity visibility checks before stream reads.
- source disappearance edge cases can be handled later if there is evidence they matter.

## Data Flow

1. dbt refresh identifies activities with changed stream samples.
2. The model builds a bounded set of sampled points per activity.
3. dbt refresh identifies activities whose heart-rate samples or heart-rate zone inputs changed.
4. The heart-rate zone model computes exact zone seconds from full-resolution heart-rate samples.
5. `activity.stream` reads `analytics.activity_stream_points` for the requested activity.
6. `activity.hrZones` reads `analytics.activity_heart_rate_zones` for the requested activity.
7. The APIs keep returning their existing response shapes.
8. Web and mobile detail pages continue rendering the same charts without UI changes.

Heart-rate zone computation must not use `activity_stream_points`, because those points are downsampled for display. Zone totals need full-resolution samples so short high- or low-intensity intervals are not lost.

## Scope

Included:
- Add dbt models for `analytics.activity_stream_points` and `analytics.activity_heart_rate_zones`.
- Add ClickHouse test/helper support for the new model.
- Change `ActivitySensorStore.getStream` to read from `analytics.activity_stream_points`.
- Change heart-rate zone reads to use `analytics.activity_heart_rate_zones`.
- Keep the existing `activity.stream` API response shape.
- Keep the existing `activity.hrZones` API response shape.
- Add focused tests that prove `activity.stream` and `activity.hrZones` no longer scan raw stream samples for the common detail payloads.

Not included:
- multiple stream resolutions
- per-channel tables
- route preview caching
- power zone caching
- workout/strength set caching
- user-visible UI changes
- fallback scan of raw stream samples from the request path

## Implementation Detail

The implementation plan should inspect the current dbt dirty-key pattern and use the smallest compatible incremental strategy. The design does not require a new timestamp column in either serving table; if the existing dbt framework needs run-state timestamps internally, that should stay inside the model query logic rather than become part of the served table contracts.

Heart-rate zone dirty keys include source heart-rate sample changes, user profile changes, and resting-heart-rate read-model changes. Profile changes invalidate recent current activities for the affected user so mutable baselines such as max heart rate and resting heart rate are recomputed proactively.

## Testing

Add or update tests to cover:
- model policy: both dbt models are incremental and use `ReplacingMergeTree(refresh_version)`.
- SQL behavior: sampled stream points and heart-rate zones are grouped by `(user_id, activity_id)`.
- repository behavior: `activity.stream` reads `analytics.activity_stream_points`.
- repository behavior: `activity.hrZones` reads `analytics.activity_heart_rate_zones`.
- API compatibility: `activity.stream` still returns the existing `StreamPoint[]` shape.
- API compatibility: `activity.hrZones` still returns the existing zone/seconds shape.

## Risks

The main risk is stale stream rows when source samples disappear while the activity remains visible. That is accepted for v1 under YAGNI. If production evidence shows stale stream rows, add the minimum needed deletion/tombstone handling in a follow-up.

The main heart-rate zone risk is stale zone totals after profile baseline changes outside the bounded recent-activity window. That is accepted for v1 under YAGNI because the current slow request path is activity-detail loading, and recent activities are the common user-visible path.
