{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH cycling_activity_state AS (
    SELECT
        activity_id,
        user_id,
        canonical_type,
        member_activity_ids,
        started_at,
        ended_at,
        is_deleted,
        refreshed_at
    FROM {{ ref('deduped_activities') }} FINAL
    WHERE canonical_type = 'cycling'
    {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_id IN {{ activity_refresh_ids() }}
            OR hasAny(member_activity_ids, {{ activity_refresh_ids() }})
        )
    {% endif %}
),

{% if is_incremental() %}
existing_route_state AS MATERIALIZED (
    SELECT
        activity_id,
        user_id,
        max(source_refreshed_at) AS source_refreshed_at,
        argMax(is_deleted, refresh_version) AS is_deleted
    FROM {{ this }} FINAL
    {% if activity_refresh_scoped %}
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND (
            activity_id IN {{ activity_refresh_ids() }}
            OR (user_id, activity_id) IN (
                SELECT user_id, activity_id FROM cycling_activity_state
            )
        )
    {% endif %}
    GROUP BY activity_id, user_id
),

{% endif %}

affected_route_keys AS MATERIALIZED (
    SELECT
        activities.activity_id AS activity_id,
        activities.user_id AS user_id
    FROM cycling_activity_state AS activities
    {% if is_incremental() %}
    {% if not activity_refresh_scoped %}
    LEFT JOIN existing_route_state AS existing_routes
        ON existing_routes.activity_id = activities.activity_id
        AND existing_routes.user_id = activities.user_id
    WHERE existing_routes.activity_id IS null
        OR existing_routes.is_deleted = 1
        OR activities.refreshed_at > existing_routes.source_refreshed_at

    UNION DISTINCT

    SELECT
        locations.activity_id AS activity_id,
        locations.user_id AS user_id
    FROM {{ ref('activity_location_sample') }} AS locations FINAL
    LEFT JOIN existing_route_state AS existing_routes
        ON existing_routes.activity_id = locations.activity_id
        AND existing_routes.user_id = locations.user_id
    WHERE (locations.user_id, locations.activity_id) IN (
        SELECT user_id, activity_id FROM cycling_activity_state
    )
        AND (
            existing_routes.activity_id IS null
            OR existing_routes.is_deleted = 1
            OR greatest(locations.source_refreshed_at, locations.refreshed_at)
                > existing_routes.source_refreshed_at
        )

    UNION DISTINCT

    SELECT
        identities.canonical_activity_id AS activity_id,
        identities.user_id AS user_id
    FROM {{ ref('activity_effort_identity') }} AS identities FINAL
    LEFT JOIN existing_route_state AS existing_routes
        ON existing_routes.activity_id = identities.canonical_activity_id
        AND existing_routes.user_id = identities.user_id
    WHERE identities.kind = 'provider_route'
        AND (identities.user_id, identities.canonical_activity_id) IN (
            SELECT user_id, activity_id FROM cycling_activity_state
        )
        AND (
            existing_routes.activity_id IS null
            OR existing_routes.is_deleted = 1
            OR identities.source_refreshed_at > existing_routes.source_refreshed_at
        )

    UNION DISTINCT

    SELECT samples.activity_id AS activity_id, samples.user_id AS user_id
    FROM {{ ref('activity_sensor_sample') }} AS samples FINAL
    LEFT JOIN existing_route_state AS existing_routes
        ON existing_routes.activity_id = samples.activity_id
        AND existing_routes.user_id = samples.user_id
    WHERE samples.channel = 'altitude'
        AND (samples.user_id, samples.activity_id) IN (
            SELECT user_id, activity_id FROM cycling_activity_state
        )
        AND (existing_routes.activity_id IS null OR samples.refreshed_at > existing_routes.source_refreshed_at)
    {% endif %}

    UNION DISTINCT

    SELECT
        existing_routes.activity_id AS activity_id,
        existing_routes.user_id AS user_id
    FROM existing_route_state AS existing_routes
    {% if not activity_refresh_scoped %}
    LEFT JOIN cycling_activity_state AS activities
        ON activities.activity_id = existing_routes.activity_id
        AND activities.user_id = existing_routes.user_id
    WHERE existing_routes.is_deleted = 0
        AND (activities.activity_id IS null OR activities.is_deleted = 1)
    {% endif %}
    {% endif %}
),

location_refresh_state AS (
    SELECT
        activity_id,
        user_id,
        max(greatest(source_refreshed_at, refreshed_at)) AS source_refreshed_at,
        countIf(is_deleted = 0 AND lat IS NOT null AND lng IS NOT null) AS live_point_count
    FROM {{ ref('activity_location_sample') }} FINAL
    WHERE (user_id, activity_id) IN (
        SELECT user_id, activity_id FROM affected_route_keys
    )
    GROUP BY activity_id, user_id
),

explicit_route_ids AS (
    SELECT
        canonical_activity_id AS activity_id,
        user_id,
        arraySort(groupUniqArray(tuple(
            source_provider,
            value,
            source_activity_id,
            assumeNotNull(source_field)
        ))) AS explicit_provider_route_ids,
        max(source_refreshed_at) AS source_refreshed_at
    FROM {{ ref('activity_effort_identity') }} FINAL
    WHERE is_deleted = 0
        AND kind = 'provider_route'
        AND (user_id, canonical_activity_id) IN (
            SELECT user_id, activity_id FROM affected_route_keys
        )
    GROUP BY canonical_activity_id, user_id
),

altitude_state AS (
    SELECT
        activity_id,
        user_id,
        max(refreshed_at) AS source_refreshed_at,
        arraySort(groupArrayIf(tuple(recorded_at, assumeNotNull(scalar)), is_deleted = 0 AND scalar IS NOT null)) AS samples
    FROM {{ ref('activity_sensor_sample') }} FINAL
    WHERE channel = 'altitude'
        AND (user_id, activity_id) IN (SELECT user_id, activity_id FROM affected_route_keys)
    GROUP BY activity_id, user_id
),

current_route_sources AS (
    SELECT
        activities.activity_id AS activity_id,
        activities.user_id AS user_id,
        activities.started_at AS started_at,
        activities.ended_at AS ended_at,
        coalesce(locations.live_point_count, 0) AS live_point_count,
        greatest(
            activities.refreshed_at,
            coalesce(locations.source_refreshed_at, toDateTime64('1970-01-01 00:00:00', 9, 'UTC')),
            coalesce(altitude.source_refreshed_at, toDateTime64('1970-01-01 00:00:00', 9, 'UTC')),
            coalesce(route_ids.source_refreshed_at, toDateTime64('1970-01-01 00:00:00', 9, 'UTC'))
        ) AS source_refreshed_at
    FROM cycling_activity_state AS activities
    LEFT JOIN altitude_state AS altitude
        ON altitude.activity_id = activities.activity_id AND altitude.user_id = activities.user_id
    LEFT JOIN location_refresh_state AS locations
        ON locations.activity_id = activities.activity_id
        AND locations.user_id = activities.user_id
    LEFT JOIN explicit_route_ids AS route_ids
        ON route_ids.activity_id = activities.activity_id
        AND route_ids.user_id = activities.user_id
    WHERE activities.is_deleted = 0
        AND (activities.user_id, activities.activity_id) IN (
            SELECT user_id, activity_id FROM affected_route_keys
        )
),

{% if is_incremental() %}
current_route_keys AS (
    SELECT
        sources.activity_id AS activity_id,
        sources.user_id AS user_id,
        sources.source_refreshed_at AS source_refreshed_at
    FROM current_route_sources AS sources
    LEFT JOIN existing_route_state AS existing_routes
        ON existing_routes.activity_id = sources.activity_id
        AND existing_routes.user_id = sources.user_id
    WHERE sources.live_point_count > 0
        {% if not activity_refresh_scoped %}
        AND (
            existing_routes.activity_id IS null
            OR existing_routes.is_deleted = 1
            OR sources.source_refreshed_at > existing_routes.source_refreshed_at
        )
        {% endif %}
),

stale_route_keys AS (
    SELECT
        existing_routes.activity_id,
        existing_routes.user_id,
        greatest(
            existing_routes.source_refreshed_at,
            coalesce(current_routes.source_refreshed_at, now64(9))
        ) AS source_refreshed_at
    FROM existing_route_state AS existing_routes
    LEFT JOIN current_route_sources AS current_routes
        ON current_routes.activity_id = existing_routes.activity_id
        AND current_routes.user_id = existing_routes.user_id
    WHERE existing_routes.is_deleted = 0
        AND (existing_routes.user_id, existing_routes.activity_id) IN (
            SELECT user_id, activity_id FROM affected_route_keys
        )
        AND (current_routes.activity_id IS null OR current_routes.live_point_count = 0)
),
{% else %}
current_route_keys AS (
    SELECT
        sources.activity_id AS activity_id,
        sources.user_id AS user_id,
        sources.source_refreshed_at AS source_refreshed_at
    FROM current_route_sources AS sources
    WHERE sources.live_point_count > 0
),
{% endif %}

current_location_samples AS MATERIALIZED (
    SELECT
        location_samples.activity_id AS activity_id,
        location_samples.user_id AS user_id,
        location_samples.recorded_at AS recorded_at,
        round(assumeNotNull(location_samples.lat), 5) AS lat,
        round(assumeNotNull(location_samples.lng), 5) AS lng,
        location_samples.provider_id AS provider_id,
        location_samples.device_id AS device_id
    FROM {{ ref('activity_location_sample') }} AS location_samples FINAL
    INNER JOIN cycling_activity_state AS activities
        ON activities.activity_id = location_samples.activity_id
        AND activities.user_id = location_samples.user_id
    WHERE (location_samples.user_id, location_samples.activity_id) IN (
        SELECT user_id, activity_id FROM current_route_keys
    )
        AND activities.is_deleted = 0
        AND location_samples.is_deleted = 0
        AND location_samples.lat IS NOT null
        AND location_samples.lng IS NOT null
        AND location_samples.lat BETWEEN -90 AND 90
        AND location_samples.lng BETWEEN -180 AND 180
        AND location_samples.recorded_at >= activities.started_at
        AND (activities.ended_at IS null OR location_samples.recorded_at <= activities.ended_at)
),

location_intervals AS (
    SELECT
        activity_id,
        user_id,
        recorded_at,
        lat,
        lng,
        lagInFrame(toNullable(recorded_at)) OVER (
            PARTITION BY user_id, activity_id
            ORDER BY recorded_at, lat, lng
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS previous_recorded_at,
        lagInFrame(toNullable(lat)) OVER (
            PARTITION BY user_id, activity_id
            ORDER BY recorded_at, lat, lng
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS previous_lat,
        lagInFrame(toNullable(lng)) OVER (
            PARTITION BY user_id, activity_id
            ORDER BY recorded_at, lat, lng
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS previous_lng
    FROM current_location_samples
),

location_interval_metrics AS (
    SELECT
        activity_id,
        user_id,
        toFloat64(dateDiff('second', previous_recorded_at, recorded_at)) AS interval_seconds,
        2 * 6371000 * asin(sqrt(
            pow(sin(radians(lat - previous_lat) / 2), 2)
            + cos(radians(previous_lat)) * cos(radians(lat))
                * pow(sin(radians(lng - previous_lng) / 2), 2)
        )) AS distance_meters
    FROM location_intervals
    WHERE previous_recorded_at IS NOT null
        AND previous_lat IS NOT null
        AND previous_lng IS NOT null
),

sampling_statistics AS (
    SELECT
        activity_id,
        user_id,
        medianExactIf(interval_seconds, interval_seconds > 0) AS median_interval_seconds,
        maxOrNull(interval_seconds) AS largest_gap_seconds,
        sumIf(interval_seconds, interval_seconds > 0) AS total_interval_seconds
    FROM location_interval_metrics
    GROUP BY activity_id, user_id
),

route_quality AS (
    SELECT
        statistics.activity_id AS activity_id,
        statistics.user_id AS user_id,
        statistics.largest_gap_seconds AS largest_gap_seconds,
        if(
            activities.ended_at IS null OR activities.ended_at <= activities.started_at,
            toNullable(toFloat64(0)),
            toNullable(
                100 * sumIf(
                    metrics.interval_seconds,
                    metrics.interval_seconds > 0
                    AND metrics.interval_seconds
                        <= least(toFloat64(30), greatest(toFloat64(5), 2 * statistics.median_interval_seconds))
                ) / dateDiff('second', activities.started_at, activities.ended_at)
            )
        ) AS coverage_pct
    FROM sampling_statistics AS statistics
    INNER JOIN cycling_activity_state AS activities
        ON activities.activity_id = statistics.activity_id AND activities.user_id = statistics.user_id
    INNER JOIN location_interval_metrics AS metrics
        ON metrics.activity_id = statistics.activity_id
        AND metrics.user_id = statistics.user_id
    GROUP BY
        statistics.activity_id,
        statistics.user_id,
        statistics.largest_gap_seconds,
        statistics.total_interval_seconds,
        statistics.median_interval_seconds,
        activities.started_at,
        activities.ended_at
),

route_geometry AS (
    SELECT
        activity_id,
        user_id,
        arraySort(groupArray((recorded_at, lat, lng))) AS ordered_points,
        arraySort(groupUniqArray(provider_id)) AS source_providers,
        arraySort(arrayFilter(device_id -> device_id IS NOT null, groupUniqArray(device_id)))
            AS source_devices
    FROM current_location_samples
    GROUP BY activity_id, user_id
),

bounded_route_geometry AS (
    SELECT
        activity_id,
        user_id,
        if(
            length(ordered_points) <= 64,
            ordered_points,
            arrayMap(
                index -> arrayElement(
                    ordered_points,
                    1 + intDiv(index * (length(ordered_points) - 1), 63)
                ),
                range(64)
            )
        ) AS bounded_ordered_points,
        source_providers,
        source_devices
    FROM route_geometry
),

current_route_rows AS (
    SELECT
        sources.activity_id AS activity_id,
        sources.user_id AS user_id,
        sources.activity_id AS canonical_activity_id,
        coalesce(route_ids.explicit_provider_route_ids,
            CAST([], 'Array(Tuple(String, String, UUID, String))')) AS explicit_provider_route_ids,
        arrayMap(point -> tuple(point.2, point.3), geometry.bounded_ordered_points) AS points,
        sources.started_at AS started_at,
        sources.ended_at AS ended_at,
        geometry.source_providers AS source_providers,
        geometry.source_devices AS source_devices,
        sources.source_refreshed_at AS source_refreshed_at,
        coalesce(quality.coverage_pct, toNullable(toFloat64(0))) AS coverage_pct,
        quality.largest_gap_seconds AS largest_gap_seconds,
        arrayMap(index -> altitude.samples[1 + intDiv(index * (length(altitude.samples) - 1), greatest(1, least(64, length(altitude.samples)) - 1))].2,
            range(least(64, length(altitude.samples)))) AS elevation_profile,
        toNullable(sum(metrics.distance_meters)) AS route_distance_meters
    FROM current_route_sources AS sources
    INNER JOIN current_route_keys AS route_keys
        ON route_keys.activity_id = sources.activity_id
        AND route_keys.user_id = sources.user_id
    INNER JOIN bounded_route_geometry AS geometry
        ON geometry.activity_id = sources.activity_id
        AND geometry.user_id = sources.user_id
    LEFT JOIN route_quality AS quality
        ON quality.activity_id = sources.activity_id
        AND quality.user_id = sources.user_id
    LEFT JOIN altitude_state AS altitude
        ON altitude.activity_id = sources.activity_id AND altitude.user_id = sources.user_id
    LEFT JOIN location_interval_metrics AS metrics
        ON metrics.activity_id = sources.activity_id
        AND metrics.user_id = sources.user_id
    LEFT JOIN explicit_route_ids AS route_ids
        ON route_ids.activity_id = sources.activity_id
        AND route_ids.user_id = sources.user_id
    GROUP BY
        sources.activity_id,
        sources.user_id,
        sources.started_at,
        sources.ended_at,
        sources.source_refreshed_at,
        route_ids.explicit_provider_route_ids,
        geometry.bounded_ordered_points,
        geometry.source_providers,
        geometry.source_devices,
        quality.coverage_pct,
        quality.largest_gap_seconds,
        altitude.samples
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    activity_id,
    user_id,
    canonical_activity_id,
    explicit_provider_route_ids,
    toNullable(arrayStringConcat(arrayMap(point -> concat(toString(point.1), ',', toString(point.2)), points), '|'))
        AS route_fingerprint,
    toNullable(arrayStringConcat(arrayMap(point -> concat(toString(point.1), ',', toString(point.2)), arrayReverse(points)), '|'))
        AS reverse_route_fingerprint,
    'forward' AS direction,
    points,
    toUInt64(length(points)) AS point_count,
    route_distance_meters,
    started_at,
    ended_at,
    elevation_profile,
    coverage_pct,
    largest_gap_seconds,
    source_providers,
    source_devices,
    if(length(points) >= 2 AND coverage_pct >= 90 AND largest_gap_seconds <= 30, 'available', 'partial') AS geometry_status,
    source_refreshed_at,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_route_rows
CROSS JOIN refresh_clock

{% if is_incremental() %}
UNION ALL

SELECT
    existing_routes.activity_id,
    existing_routes.user_id,
    existing_routes.canonical_activity_id,
    existing_routes.explicit_provider_route_ids,
    existing_routes.route_fingerprint,
    existing_routes.reverse_route_fingerprint,
    existing_routes.direction,
    existing_routes.points,
    existing_routes.point_count,
    existing_routes.route_distance_meters,
    existing_routes.started_at,
    existing_routes.ended_at,
    existing_routes.elevation_profile,
    existing_routes.coverage_pct,
    existing_routes.largest_gap_seconds,
    existing_routes.source_providers,
    existing_routes.source_devices,
    'unavailable' AS geometry_status,
    stale_routes.source_refreshed_at,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM {{ this }} AS existing_routes FINAL
INNER JOIN stale_route_keys AS stale_routes
    ON stale_routes.activity_id = existing_routes.activity_id
    AND stale_routes.user_id = existing_routes.user_id
CROSS JOIN refresh_clock
WHERE existing_routes.is_deleted = 0
{% endif %}
