{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, provider_id)'
) }}

WITH current_providers AS (
    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'provider_connection') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS null
        AND deleted_at IS null

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'daily_metrics') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('ingest', 'metric_stream') }} FINAL
    WHERE is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'food_entry') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'health_event') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'lab_panel') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'lab_result') }} FINAL
    WHERE _peerdb_is_deleted = 0

    UNION DISTINCT

    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ source('postgres_fitness', 'journal_entry') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

{% if is_incremental() %}
existing_providers AS (
    SELECT DISTINCT
        user_id,
        provider_id
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
),
{% endif %}

providers AS (
    SELECT
        user_id,
        provider_id
    FROM current_providers
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT
        user_id,
        provider_id
    FROM existing_providers
    {% endif %}
),

activity_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_absent_at IS null
        AND deleted_at IS null
    GROUP BY user_id, provider_id
),

daily_metric_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'daily_metrics') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

sleep_session_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

body_measurement_counts AS (
    SELECT
        user_id,
        provider_id,
        uniqExact(COALESCE(
            external_id,
            concat(provider_id, ':', toString(user_id), ':', toString(recorded_at), ':', COALESCE(device_id, ''))
        )) AS count
    FROM analytics.body_measurement_sample FINAL
    WHERE _peerdb_is_deleted = 0
        AND channel IN (
            'body_weight',
            'body_fat_percentage',
            'muscle_mass',
            'bone_mass',
            'body_water_percentage',
            'body_mass_index',
            'height',
            'waist_circumference',
            'systolic_blood_pressure',
            'diastolic_blood_pressure',
            'heart_pulse',
            'body_temperature'
        )
    GROUP BY user_id, provider_id
),

metric_stream_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('ingest', 'metric_stream') }} FINAL
    WHERE is_deleted = 0
    GROUP BY user_id, provider_id
),

food_entry_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'food_entry') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

health_event_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'health_event') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

nutrition_daily_counts AS (
    SELECT
        user_id,
        provider_id,
        uniqExact(date) AS count
    FROM {{ source('postgres_fitness', 'food_entry') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

lab_panel_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'lab_panel') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

lab_result_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'lab_result') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

journal_entry_counts AS (
    SELECT
        user_id,
        provider_id,
        count() AS count
    FROM {{ source('postgres_fitness', 'journal_entry') }} FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY user_id, provider_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    providers.user_id AS user_id,
    providers.provider_id AS provider_id,
    coalesce(activity_counts.count, 0) AS activities,
    coalesce(daily_metric_counts.count, 0) AS daily_metrics,
    coalesce(sleep_session_counts.count, 0) AS sleep_sessions,
    coalesce(body_measurement_counts.count, 0) AS body_measurements,
    coalesce(food_entry_counts.count, 0) AS food_entries,
    coalesce(health_event_counts.count, 0) AS health_events,
    coalesce(metric_stream_counts.count, 0) AS metric_stream,
    coalesce(nutrition_daily_counts.count, 0) AS nutrition_daily,
    coalesce(lab_panel_counts.count, 0) AS lab_panels,
    coalesce(lab_result_counts.count, 0) AS lab_results,
    coalesce(journal_entry_counts.count, 0) AS journal_entries,
    if(current_providers.provider_id IS null, 1, 0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM providers
CROSS JOIN refresh_clock
LEFT JOIN current_providers
    ON current_providers.user_id = providers.user_id
    AND current_providers.provider_id = providers.provider_id
LEFT JOIN activity_counts
    ON activity_counts.user_id = providers.user_id
    AND activity_counts.provider_id = providers.provider_id
LEFT JOIN daily_metric_counts
    ON daily_metric_counts.user_id = providers.user_id
    AND daily_metric_counts.provider_id = providers.provider_id
LEFT JOIN sleep_session_counts
    ON sleep_session_counts.user_id = providers.user_id
    AND sleep_session_counts.provider_id = providers.provider_id
LEFT JOIN body_measurement_counts
    ON body_measurement_counts.user_id = providers.user_id
    AND body_measurement_counts.provider_id = providers.provider_id
LEFT JOIN metric_stream_counts
    ON metric_stream_counts.user_id = providers.user_id
    AND metric_stream_counts.provider_id = providers.provider_id
LEFT JOIN food_entry_counts
    ON food_entry_counts.user_id = providers.user_id
    AND food_entry_counts.provider_id = providers.provider_id
LEFT JOIN health_event_counts
    ON health_event_counts.user_id = providers.user_id
    AND health_event_counts.provider_id = providers.provider_id
LEFT JOIN nutrition_daily_counts
    ON nutrition_daily_counts.user_id = providers.user_id
    AND nutrition_daily_counts.provider_id = providers.provider_id
LEFT JOIN lab_panel_counts
    ON lab_panel_counts.user_id = providers.user_id
    AND lab_panel_counts.provider_id = providers.provider_id
LEFT JOIN lab_result_counts
    ON lab_result_counts.user_id = providers.user_id
    AND lab_result_counts.provider_id = providers.provider_id
LEFT JOIN journal_entry_counts
    ON journal_entry_counts.user_id = providers.user_id
    AND journal_entry_counts.provider_id = providers.provider_id
