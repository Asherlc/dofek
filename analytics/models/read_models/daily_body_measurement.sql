{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, measurement_id)',
    indexes=[{
        'name': 'refreshed_at_minmax',
        'definition': 'refreshed_at TYPE minmax GRANULARITY 1'
    }],
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH
body_user_state AS (
    SELECT
        user_id,
        max(refreshed_at) AS source_synced_at
    FROM {{ ref('body_measurement') }} FINAL
    GROUP BY user_id
),

{% if is_incremental() %}
target_user_state AS (
    SELECT
        user_id,
        max(source_synced_at) AS last_source_synced_at
    FROM {{ this }} FINAL
    GROUP BY user_id
),
{% endif %}

changed_user_watermarks AS (
    SELECT
        body_user_state.user_id AS user_id,
        body_user_state.source_synced_at AS source_synced_at
    FROM body_user_state
    {% if is_incremental() %}
    LEFT JOIN target_user_state
        ON target_user_state.user_id = body_user_state.user_id
    WHERE target_user_state.user_id IS NULL
        OR body_user_state.source_synced_at > target_user_state.last_source_synced_at
    {% endif %}
),

live_body AS (
    SELECT
        CAST(body.id, 'UUID') AS measurement_id,
        CAST(body.user_id, 'UUID') AS user_id,
        CAST(toDate(body.recorded_at), 'Date') AS date,
        body.recorded_at AS recorded_at,
        body.weight_kg AS weight_kg,
        body.body_fat_pct AS body_fat_pct
    FROM {{ ref('body_measurement') }} AS body FINAL
    INNER JOIN changed_user_watermarks
        ON changed_user_watermarks.user_id = body.user_id
    WHERE body.weight_kg IS NOT NULL
        AND body.weight_kg > 0
        AND body.is_deleted = 0
),

existing_rows AS (
    {% if is_incremental() %}
    SELECT
        existing.measurement_id AS measurement_id,
        existing.user_id AS user_id,
        existing.date AS date,
        existing.recorded_at AS recorded_at,
        existing.weight_kg AS weight_kg,
        existing.body_fat_pct AS body_fat_pct
    FROM {{ this }} AS existing FINAL
    INNER JOIN changed_user_watermarks
        ON changed_user_watermarks.user_id = existing.user_id
    WHERE existing.is_deleted = 0
    {% else %}
    SELECT
        live_body.measurement_id AS measurement_id,
        live_body.user_id AS user_id,
        live_body.date AS date,
        live_body.recorded_at AS recorded_at,
        live_body.weight_kg AS weight_kg,
        live_body.body_fat_pct AS body_fat_pct
    FROM live_body
    WHERE 0
    {% endif %}
),

measurement_keys AS (
    SELECT
        measurement_id,
        user_id
    FROM live_body
    UNION DISTINCT
    SELECT
        measurement_id,
        user_id
    FROM existing_rows
),

rows_to_write AS (
    SELECT
        measurement_keys.measurement_id AS measurement_id,
        measurement_keys.user_id AS user_id,
        coalesce(live_body.date, existing_rows.date) AS date,
        coalesce(live_body.recorded_at, existing_rows.recorded_at) AS recorded_at,
        coalesce(live_body.weight_kg, existing_rows.weight_kg) AS weight_kg,
        coalesce(live_body.body_fat_pct, existing_rows.body_fat_pct) AS body_fat_pct,
        if(live_body.measurement_id IS NULL, 1, 0) AS is_deleted,
        changed_user_watermarks.source_synced_at AS source_synced_at
    FROM measurement_keys
    INNER JOIN changed_user_watermarks
        ON changed_user_watermarks.user_id = measurement_keys.user_id
    LEFT JOIN live_body
        ON live_body.measurement_id = measurement_keys.measurement_id
        AND live_body.user_id = measurement_keys.user_id
    LEFT JOIN existing_rows
        ON existing_rows.measurement_id = measurement_keys.measurement_id
        AND existing_rows.user_id = measurement_keys.user_id
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9, 'UTC') AS refreshed_at
)

SELECT
    rows_to_write.measurement_id AS measurement_id,
    rows_to_write.user_id AS user_id,
    rows_to_write.date AS date,
    rows_to_write.recorded_at AS recorded_at,
    rows_to_write.weight_kg AS weight_kg,
    rows_to_write.body_fat_pct AS body_fat_pct,
    rows_to_write.is_deleted AS is_deleted,
    rows_to_write.source_synced_at AS source_synced_at,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM rows_to_write
CROSS JOIN refresh_clock
