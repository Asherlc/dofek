{% macro activity_pace_durations() %}
    {{ return([5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200]) }}
{% endmacro %}

{% macro activity_sensor_dirty_keys(channel, target_relation, batch_size=32, read_prior_state=false, captured_keys=none, required_durations=none, target_user_ids=none) %}
{% if batch_size is not none and (batch_size < 1 or batch_size > 32) %}
    {{ exceptions.raise_compiler_error('Activity sensor writes admit at most 32 keys') }}
{% endif %}
{% if captured_keys is not none %}
    {% if captured_keys is not sequence or captured_keys is string or captured_keys | length < 1 or captured_keys | length > 32 %}
        {{ exceptions.raise_compiler_error('activity_sensor_captured_keys must contain 1 to 32 exact source pairs') }}
    {% endif %}
    {% for key in captured_keys %}
        {% if key is not mapping %}
            {{ exceptions.raise_compiler_error('Captured activity sensor keys must be objects') }}
        {% endif %}
        {% for field in ['user_id', 'activity_id'] %}
            {% if key[field] is not string or not modules.re.fullmatch('[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', key[field]) %}
                {{ exceptions.raise_compiler_error('Captured activity sensor key requires UUID ' ~ field) }}
            {% endif %}
        {% endfor %}
        {% for field in ['source_activity_version', 'source_sensor_version'] %}
            {% if key[field] is not string or not modules.re.fullmatch('0|[1-9][0-9]{0,19}', key[field]) or key[field] | int > 18446744073709551615 %}
                {{ exceptions.raise_compiler_error('Captured activity sensor key requires lossless UInt64 ' ~ field) }}
            {% endif %}
        {% endfor %}
    {% endfor %}
{% endif %}
WITH shared_state AS (
    {{ activity_sensor_key_state(channel, target_relation, read_prior_state=read_prior_state, required_durations=required_durations, target_user_ids=target_user_ids) }}
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
    source_is_deleted,
    assumeNotNull(coalesce(prior_refresh_version, source_activity_version)) AS processing_age
FROM shared_state
WHERE is_dirty
{% if captured_keys is not none %}
    AND (user_id, activity_id, source_activity_version, source_sensor_version) IN (
        {% for key in captured_keys %}
        (toUUID('{{ key.user_id }}'), toUUID('{{ key.activity_id }}'), toUInt64('{{ key.source_activity_version }}'), toUInt64('{{ key.source_sensor_version }}')){% if not loop.last %},{% endif %}
        {% endfor %}
    )
{% endif %}
{% if batch_size is not none %}
-- A pending key keeps its last processing age even if its day refreshes again.
-- Unseen keys keep their activity clock when a shared sensor day refreshes.
ORDER BY
    coalesce(prior_refresh_version, source_activity_version),
    greatest(source_activity_version, source_sensor_version),
    user_id,
    activity_id
LIMIT {{ batch_size }}
{% endif %}
{% endmacro %}

{% macro activity_sensor_key_state(channel, target_relation, read_prior_state=false, required_durations=none, target_user_ids=none, target_activity_keys=none) %}
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
    {% if target_user_ids is not none %}
    WHERE user_id IN {{ target_user_ids }}
    {% endif %}
    {% if target_activity_keys is not none %}
        AND (user_id, activity_id) IN {{ target_activity_keys }}
    {% endif %}
),

prior_state AS MATERIALIZED (
    {% if read_prior_state or is_incremental() %}
    SELECT
        user_id,
        activity_id,
        tupleElement(marker, 1) AS canonical_type,
        tupleElement(marker, 2) AS started_at,
        tupleElement(marker, 3) AS ended_at,
        tupleElement(marker, 4) AS source_activity_version,
        tupleElement(marker, 5) AS source_sensor_version,
        tupleElement(marker, 6) AS is_deleted,
        marker_refresh_version AS refresh_version,
        marker_complete,
        marker_count,
        marker_durations,
        marker_coherent,
        invalid_durations
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
            max(refresh_version) AS marker_refresh_version,
            count() AS marker_count,
            uniqExact(tuple(canonical_type, started_at, ended_at, source_activity_version, source_sensor_version, is_deleted, refresh_version)) = 1 AS marker_coherent,
            {% if required_durations is not none %}
            arraySort(groupUniqArray(duration_seconds)) AS marker_durations,
            arrayFilter(duration -> duration NOT IN ({{ required_durations | join(', ') }}), marker_durations) AS invalid_durations,
            {% else %}
            CAST([], 'Array(UInt32)') AS marker_durations,
            CAST([], 'Array(UInt32)') AS invalid_durations,
            {% endif %}
            {% if required_durations is not none %}
            arraySort(groupUniqArray(duration_seconds)) = [{{ required_durations | join(', ') }}]
                AND uniqExact(tuple(canonical_type, started_at, ended_at, source_activity_version, source_sensor_version, is_deleted, refresh_version)) = 1 AS marker_complete
            {% else %}
            toUInt8(1) AS marker_complete
            {% endif %}
        FROM {{ target_relation }} FINAL
        {% if target_user_ids is not none %}
        WHERE user_id IN {{ target_user_ids }}
        {% endif %}
        {% if target_activity_keys is not none %}
            AND (user_id, activity_id) IN {{ target_activity_keys }}
        {% endif %}
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
        CAST(null, 'Nullable(UInt64)') AS refresh_version,
        toUInt8(0) AS marker_complete,
        toUInt64(0) AS marker_count,
        CAST([], 'Array(UInt32)') AS marker_durations,
        toUInt8(0) AS marker_coherent,
        CAST([], 'Array(UInt32)') AS invalid_durations
    WHERE 0
    {% endif %}
),

key_state AS MATERIALIZED (
    SELECT
        coalesce(activity_state.user_id, prior_state.user_id) AS user_id,
        coalesce(activity_state.activity_id, prior_state.activity_id) AS activity_id,
        coalesce(activity_state.canonical_type, prior_state.canonical_type) AS canonical_type,
        coalesce(activity_state.started_at, prior_state.started_at) AS started_at,
        coalesce(activity_state.ended_at, prior_state.ended_at) AS ended_at,
        isNotNull(activity_state.activity_id) AS current_present,
        isNotNull(prior_state.activity_id) AS prior_present,
        prior_state.canonical_type AS prior_canonical_type,
        prior_state.started_at AS prior_started_at,
        prior_state.ended_at AS prior_ended_at,
        coalesce(activity_state.source_activity_version, prior_state.source_activity_version) AS source_activity_version,
        coalesce(activity_state.source_is_deleted, toUInt8(1)) AS source_is_deleted,
        prior_state.activity_id AS prior_activity_id,
        prior_state.source_activity_version AS prior_activity_version,
        prior_state.source_sensor_version AS prior_sensor_version,
        prior_state.is_deleted AS prior_is_deleted,
        prior_state.refresh_version AS prior_refresh_version,
        prior_state.marker_complete AS prior_marker_complete,
        prior_state.marker_count AS marker_count,
        prior_state.marker_durations AS marker_durations,
        prior_state.marker_coherent AS marker_coherent,
        prior_state.invalid_durations AS invalid_durations
    FROM activity_state
    FULL OUTER JOIN prior_state USING (user_id, activity_id)
),

window_dates AS MATERIALIZED (
    SELECT DISTINCT
        user_id,
        activity_id,
        arrayJoin(arrayConcat(
            arrayMap(
                offset -> toDate(assumeNotNull(started_at)) + offset,
                range(toUInt32(greatest(0, dateDiff('day',
                    toDate(assumeNotNull(started_at)),
                    toDate(assumeNotNull(ended_at))
                ))) + 1)
            ),
            if(prior_started_at IS null, CAST([], 'Array(Date)'),
                arrayMap(
                    offset -> toDate(assumeNotNull(coalesce(prior_started_at, started_at))) + offset,
                    range(toUInt32(greatest(0, dateDiff('day',
                        toDate(assumeNotNull(coalesce(prior_started_at, started_at))),
                        toDate(assumeNotNull(coalesce(prior_ended_at, ended_at)))
                    ))) + 1)
                )
            )
        )) AS recorded_date
    FROM key_state
    WHERE source_is_deleted = 0
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
        {% if target_user_ids is not none %}
        AND user_id IN {{ target_user_ids }}
        {% endif %}
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
        key_state.current_present AS current_present,
        key_state.prior_present AS prior_present,
        key_state.prior_canonical_type AS prior_canonical_type,
        key_state.prior_started_at AS prior_started_at,
        key_state.prior_ended_at AS prior_ended_at,
        key_state.source_activity_version AS source_activity_version,
        key_state.source_is_deleted AS source_is_deleted,
        key_state.prior_activity_id AS prior_activity_id,
        key_state.prior_activity_version AS prior_activity_version,
        key_state.prior_sensor_version AS prior_sensor_version,
        key_state.prior_is_deleted AS prior_is_deleted,
        key_state.prior_refresh_version AS prior_refresh_version,
        key_state.prior_marker_complete AS prior_marker_complete,
        key_state.marker_count AS marker_count,
        key_state.marker_durations AS marker_durations,
        key_state.marker_coherent AS marker_coherent,
        key_state.invalid_durations AS invalid_durations,
        greatest(
            coalesce(key_state.prior_sensor_version, toUInt64(0)),
            coalesce(sensor_versions.source_sensor_version, toUInt64(0))
        ) AS source_sensor_version
    FROM key_state
    LEFT JOIN sensor_versions USING (user_id, activity_id)
)

SELECT
    user_id,
    activity_id,
    canonical_type,
    started_at,
    ended_at,
    current_present,
    prior_present,
    prior_canonical_type,
    prior_started_at,
    prior_ended_at,
    source_activity_version,
    source_is_deleted,
    prior_activity_id,
    prior_activity_version,
    prior_sensor_version,
    prior_is_deleted,
    prior_refresh_version,
    prior_marker_complete,
    marker_count,
    marker_durations,
    marker_coherent,
    invalid_durations,
    source_sensor_version,
    ((prior_activity_id IS null AND source_is_deleted = 0)
    OR source_activity_version != prior_activity_version
    OR (source_is_deleted = 1 AND prior_is_deleted = 0)
    OR (source_is_deleted = 0 AND source_sensor_version > prior_sensor_version)
    OR prior_marker_complete = 0) AS is_dirty
FROM versioned_keys
{% endmacro %}
