{% macro activity_sensor_dirty_keys(channel, target_relation, batch_size=32) %}
-- Consumers persist a row even for empty results, including the complete
-- activity/sensor version pair and current bounds. Sensor versions use the
-- canonical serialized writer's clock; a later refresh exceeds prior day maxima.
-- Consumers enable join_use_nulls and enable_materialized_cte.
WITH activity_state AS MATERIALIZED (
    SELECT
        user_id,
        activity_id,
        canonical_type,
        started_at,
        coalesce(ended_at, started_at + INTERVAL 12 HOUR) AS ended_at,
        refresh_version AS source_activity_version,
        is_deleted AS source_is_deleted
    FROM {{ ref('deduped_activities') }} FINAL
),

prior_state AS MATERIALIZED (
    {% if is_incremental() %}
    SELECT
        user_id,
        activity_id,
        tupleElement(marker, 1) AS canonical_type,
        tupleElement(marker, 2) AS started_at,
        tupleElement(marker, 3) AS ended_at,
        tupleElement(marker, 4) AS source_activity_version,
        tupleElement(marker, 5) AS source_sensor_version,
        tupleElement(marker, 6) AS is_deleted,
        marker_refresh_version AS refresh_version
    FROM (
        -- Targets may have several durations/buckets per activity. Read one
        -- complete latest marker; a live variant wins a tied lifecycle clock.
        SELECT
            user_id,
            activity_id,
            argMax(
                tuple(canonical_type, started_at, ended_at, source_activity_version, source_sensor_version, is_deleted),
                tuple(refresh_version, toUInt8(1) - is_deleted)
            ) AS marker,
            max(refresh_version) AS marker_refresh_version
        FROM {{ target_relation }} FINAL
        GROUP BY user_id, activity_id
    )
    {% else %}
    SELECT
        CAST(null, 'Nullable(UUID)') AS user_id,
        CAST(null, 'Nullable(UUID)') AS activity_id,
        CAST(null, 'Nullable(String)') AS canonical_type,
        CAST(null, 'Nullable(DateTime64(6, \'UTC\'))') AS started_at,
        CAST(null, 'Nullable(DateTime64(6, \'UTC\'))') AS ended_at,
        CAST(null, 'Nullable(UInt64)') AS source_activity_version,
        CAST(null, 'Nullable(UInt64)') AS source_sensor_version,
        CAST(null, 'Nullable(UInt8)') AS is_deleted,
        CAST(null, 'Nullable(UInt64)') AS refresh_version
    WHERE 0
    {% endif %}
),

all_keys AS (
    SELECT
        user_id,
        activity_id
    FROM activity_state
    UNION DISTINCT
    SELECT
        user_id,
        activity_id
    FROM prior_state
),

key_state AS MATERIALIZED (
    SELECT
        all_keys.user_id AS user_id,
        all_keys.activity_id AS activity_id,
        coalesce(activity_state.canonical_type, prior_state.canonical_type) AS canonical_type,
        coalesce(activity_state.started_at, prior_state.started_at) AS started_at,
        coalesce(activity_state.ended_at, prior_state.ended_at) AS ended_at,
        prior_state.started_at AS prior_started_at,
        prior_state.ended_at AS prior_ended_at,
        coalesce(activity_state.source_activity_version, prior_state.source_activity_version) AS source_activity_version,
        coalesce(activity_state.source_is_deleted, toUInt8(1)) AS source_is_deleted,
        prior_state.activity_id AS prior_activity_id,
        prior_state.source_activity_version AS prior_activity_version,
        prior_state.source_sensor_version AS prior_sensor_version,
        prior_state.is_deleted AS prior_is_deleted,
        prior_state.refresh_version AS prior_refresh_version
    FROM all_keys
    LEFT JOIN activity_state USING (user_id, activity_id)
    LEFT JOIN prior_state USING (user_id, activity_id)
),

window_bounds AS (
    SELECT
        user_id,
        activity_id,
        started_at,
        ended_at
    FROM key_state
    WHERE source_is_deleted = 0
    UNION DISTINCT
    SELECT
        user_id,
        activity_id,
        prior_started_at AS started_at,
        prior_ended_at AS ended_at
    FROM key_state
    WHERE source_is_deleted = 0 AND prior_started_at IS NOT null
),

window_dates AS MATERIALIZED (
    SELECT DISTINCT
        user_id,
        activity_id,
        arrayJoin(arrayMap(
            offset -> toDate(started_at) + offset,
            range(toUInt32(greatest(0, dateDiff('day', toDate(started_at), toDate(ended_at)))) + 1)
        )) AS recorded_date
    FROM window_bounds
),

day_versions AS (
    -- No FINAL: obsolete rows cannot reduce a maximum refresh watermark.
    -- The aggregate projection avoids expanding sensor samples to find keys.
    SELECT
        user_id,
        recorded_date,
        max(refresh_version) AS source_refresh_version
    FROM {{ ref('deduped_sensor') }}
    WHERE channel = '{{ channel }}'
        AND (user_id, recorded_date) IN (
            SELECT
                user_id,
                recorded_date
            FROM window_dates
        )
    GROUP BY user_id, channel, recorded_date
),

sensor_versions AS (
    SELECT
        window_dates.user_id AS user_id,
        window_dates.activity_id AS activity_id,
        max(day_versions.source_refresh_version) AS source_sensor_version
    FROM window_dates
    LEFT JOIN day_versions USING (user_id, recorded_date)
    GROUP BY window_dates.user_id, window_dates.activity_id
),

versioned_keys AS (
    SELECT
        key_state.user_id AS user_id,
        key_state.activity_id AS activity_id,
        key_state.canonical_type AS canonical_type,
        key_state.started_at AS started_at,
        key_state.ended_at AS ended_at,
        key_state.prior_started_at AS prior_started_at,
        key_state.prior_ended_at AS prior_ended_at,
        key_state.source_activity_version AS source_activity_version,
        key_state.source_is_deleted AS source_is_deleted,
        key_state.prior_activity_id AS prior_activity_id,
        key_state.prior_activity_version AS prior_activity_version,
        key_state.prior_sensor_version AS prior_sensor_version,
        key_state.prior_is_deleted AS prior_is_deleted,
        key_state.prior_refresh_version AS prior_refresh_version,
        greatest(
            coalesce(key_state.prior_sensor_version, toUInt64(0)),
            coalesce(sensor_versions.source_sensor_version, toUInt64(0))
        ) AS source_sensor_version
    FROM key_state
    LEFT JOIN sensor_versions USING (user_id, activity_id)
)

SELECT
    assumeNotNull(user_id) AS user_id,
    assumeNotNull(activity_id) AS activity_id,
    assumeNotNull(canonical_type) AS canonical_type,
    assumeNotNull(started_at) AS started_at,
    assumeNotNull(ended_at) AS ended_at,
    prior_started_at,
    prior_ended_at,
    assumeNotNull(source_activity_version) AS source_activity_version,
    source_sensor_version,
    source_is_deleted
FROM versioned_keys
WHERE (prior_activity_id IS null AND source_is_deleted = 0)
    OR source_activity_version != prior_activity_version
    OR (source_is_deleted = 1 AND prior_is_deleted = 0)
    OR (source_is_deleted = 0 AND source_sensor_version > prior_sensor_version)
-- A pending key keeps its last processing age even if its day refreshes again.
-- New keys start at their causal source age, rather than jumping ahead at zero.
ORDER BY
    coalesce(prior_refresh_version, greatest(source_activity_version, source_sensor_version)),
    greatest(source_activity_version, source_sensor_version),
    user_id,
    activity_id
LIMIT {{ batch_size }}
{% endmacro %}
