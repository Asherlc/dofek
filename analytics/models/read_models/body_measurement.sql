{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH source_user_refreshes AS (
    SELECT
        user_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('analytics', 'body_measurement_sample') }} FINAL
    GROUP BY user_id
),

priority_refresh AS (
    SELECT coalesce(
        max(source_refreshed_at),
        toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
    ) AS source_refreshed_at
    FROM (
        SELECT max(_peerdb_synced_at) AS source_refreshed_at
        FROM {{ source('postgres_fitness', 'provider_priority') }} FINAL

        UNION ALL

        SELECT max(_peerdb_synced_at) AS source_refreshed_at
        FROM {{ source('postgres_fitness', 'device_priority') }} FINAL
    )
),

{% if is_incremental() %}
existing_user_state AS (
    SELECT
        user_id,
        max(refreshed_at) AS refreshed_at
    FROM {{ this }} FINAL
    GROUP BY user_id
),
{% endif %}

dirty_users AS MATERIALIZED (
    SELECT source_user_refreshes.user_id AS user_id
    FROM source_user_refreshes
    CROSS JOIN priority_refresh
    {% if is_incremental() %}
    LEFT JOIN existing_user_state
        ON existing_user_state.user_id = source_user_refreshes.user_id
    WHERE existing_user_state.user_id IS NULL
        OR source_user_refreshes.source_refreshed_at > existing_user_state.refreshed_at
        OR priority_refresh.source_refreshed_at > existing_user_state.refreshed_at
    {% endif %}
),

body_measurement_samples AS (
    SELECT
        id,
        provider_id,
        user_id,
        recorded_at,
        _peerdb_synced_at AS sample_refreshed_at,
        device_id,
        channel,
        scalar,
        ifNull(
            concat(provider_id, ':', external_id),
            concat(
                provider_id,
                ':',
                toString(user_id),
                ':',
                toString(recorded_at),
                ':',
                ifNull(device_id, '')
            )
        ) AS measurement_key
    FROM {{ source('analytics', 'body_measurement_sample') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND user_id IN (SELECT user_id FROM dirty_users)
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
),

active_body AS (
    SELECT
        min(id) AS id,
        provider_id,
        user_id,
        measurement_key AS external_id,
        recorded_at,
        min(sample_refreshed_at) AS created_at,
        max(sample_refreshed_at) AS source_refreshed_at,
        device_id AS source_name,
        maxIf(scalar, channel = 'body_weight') AS weight_kg,
        maxIf(scalar, channel = 'body_fat_percentage') AS body_fat_pct,
        maxIf(scalar, channel = 'muscle_mass') AS muscle_mass_kg,
        maxIf(scalar, channel = 'bone_mass') AS bone_mass_kg,
        maxIf(scalar, channel = 'body_water_percentage') AS water_pct,
        maxIf(scalar, channel = 'body_mass_index') AS bmi,
        maxIf(scalar, channel = 'height') AS height_cm,
        maxIf(scalar, channel = 'waist_circumference') AS waist_circumference_cm,
        maxIf(scalar, channel = 'systolic_blood_pressure') AS systolic_bp,
        maxIf(scalar, channel = 'diastolic_blood_pressure') AS diastolic_bp,
        maxIf(scalar, channel = 'heart_pulse') AS heart_pulse,
        maxIf(scalar, channel = 'body_temperature') AS temperature_c
    FROM body_measurement_samples
    GROUP BY
        provider_id,
        user_id,
        measurement_key,
        recorded_at,
        device_id
),

active_provider_priority AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'provider_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

active_device_priority AS (
    SELECT *
    FROM {{ source('postgres_fitness', 'device_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0
),

device_priority_match AS (
    SELECT
        measurement_id,
        body_priority,
        priority,
        source_refreshed_at
    FROM (
        SELECT
            active_body.id AS measurement_id,
            active_device_priority.body_priority AS body_priority,
            active_device_priority.priority AS priority,
            active_device_priority._peerdb_synced_at AS source_refreshed_at,
            row_number() OVER (
                PARTITION BY active_body.id
                ORDER BY length(active_device_priority.source_name_pattern) DESC
            ) AS row_number
        FROM active_body
        INNER JOIN active_device_priority
            ON active_device_priority.provider_id = active_body.provider_id
            AND active_body.source_name LIKE active_device_priority.source_name_pattern
    )
    WHERE row_number = 1
),

ranked AS (
    SELECT
        active_body.id AS id,
        active_body.provider_id AS provider_id,
        active_body.user_id AS user_id,
        active_body.external_id AS external_id,
        active_body.recorded_at AS recorded_at,
        active_body.created_at AS created_at,
        greatest(
            active_body.source_refreshed_at,
            coalesce(
                active_provider_priority._peerdb_synced_at,
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            ),
            coalesce(
                device_priority_match.source_refreshed_at,
                toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
            )
        ) AS source_refreshed_at,
        active_body.weight_kg AS weight_kg,
        active_body.body_fat_pct AS body_fat_pct,
        active_body.muscle_mass_kg AS muscle_mass_kg,
        active_body.bone_mass_kg AS bone_mass_kg,
        active_body.water_pct AS water_pct,
        active_body.bmi AS bmi,
        active_body.height_cm AS height_cm,
        active_body.waist_circumference_cm AS waist_circumference_cm,
        active_body.systolic_bp AS systolic_bp,
        active_body.diastolic_bp AS diastolic_bp,
        active_body.heart_pulse AS heart_pulse,
        active_body.temperature_c AS temperature_c,
        active_body.source_name AS source_name,
        coalesce(
            device_priority_match.body_priority,
            active_provider_priority.body_priority,
            device_priority_match.priority,
            active_provider_priority.priority,
            100
        ) AS priority
    FROM active_body
    LEFT JOIN active_provider_priority
        ON active_provider_priority.provider_id = active_body.provider_id
    LEFT JOIN device_priority_match
        ON device_priority_match.measurement_id = active_body.id
),

ordered_measurements AS (
    SELECT
        id,
        user_id,
        recorded_at,
        row_number() OVER (
            PARTITION BY user_id
            ORDER BY recorded_at, toString(id)
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS measurement_number,
        lagInFrame(recorded_at, 1, recorded_at) OVER (
            PARTITION BY user_id
            ORDER BY recorded_at, toString(id)
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS previous_recorded_at
    FROM ranked
),

group_boundaries AS (
    SELECT
        id AS measurement_id,
        user_id,
        recorded_at,
        if(
            measurement_number = 1
            OR dateDiff('second', previous_recorded_at, recorded_at) >= 300,
            toUInt8(1),
            toUInt8(0)
        ) AS is_group_start
    FROM ordered_measurements
),

final_groups AS (
    SELECT
        measurement_id,
        user_id,
        sum(is_group_start) OVER (
            PARTITION BY user_id
            ORDER BY recorded_at, toString(measurement_id)
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS group_id
    FROM group_boundaries
),

best AS (
    SELECT *
    FROM (
        SELECT
            final_groups.group_id AS group_id,
            ranked.id AS id,
            ranked.provider_id AS provider_id,
            ranked.user_id AS user_id,
            ranked.external_id AS external_id,
            ranked.recorded_at AS recorded_at,
            ranked.created_at AS created_at,
            ranked.source_refreshed_at AS source_refreshed_at,
            ranked.source_name AS source_name,
            ranked.priority AS priority,
            row_number() OVER (
                PARTITION BY final_groups.user_id, final_groups.group_id
                ORDER BY ranked.priority ASC, toString(ranked.id) ASC
            ) AS row_number
        FROM final_groups
        INNER JOIN ranked
            ON ranked.id = final_groups.measurement_id
    )
    WHERE row_number = 1
),

current_body_measurements AS (
    SELECT
        best.id AS id,
        best.provider_id AS provider_id,
        best.user_id AS user_id,
        best.external_id AS external_id,
        best.recorded_at AS recorded_at,
        best.created_at AS created_at,
        argMinIf(ranked.weight_kg, ranked.priority, ranked.weight_kg IS NOT NULL) AS weight_kg,
        argMinIf(
            ranked.body_fat_pct,
            ranked.priority,
            ranked.body_fat_pct IS NOT NULL
        ) AS body_fat_pct,
        argMinIf(
            ranked.muscle_mass_kg,
            ranked.priority,
            ranked.muscle_mass_kg IS NOT NULL
        ) AS muscle_mass_kg,
        argMinIf(
            ranked.bone_mass_kg,
            ranked.priority,
            ranked.bone_mass_kg IS NOT NULL
        ) AS bone_mass_kg,
        argMinIf(ranked.water_pct, ranked.priority, ranked.water_pct IS NOT NULL) AS water_pct,
        argMinIf(ranked.bmi, ranked.priority, ranked.bmi IS NOT NULL) AS bmi,
        argMinIf(ranked.height_cm, ranked.priority, ranked.height_cm IS NOT NULL) AS height_cm,
        argMinIf(
            ranked.waist_circumference_cm,
            ranked.priority,
            ranked.waist_circumference_cm IS NOT NULL
        ) AS waist_circumference_cm,
        argMinIf(
            ranked.systolic_bp,
            ranked.priority,
            ranked.systolic_bp IS NOT NULL
        ) AS systolic_bp,
        argMinIf(
            ranked.diastolic_bp,
            ranked.priority,
            ranked.diastolic_bp IS NOT NULL
        ) AS diastolic_bp,
        argMinIf(
            ranked.heart_pulse,
            ranked.priority,
            ranked.heart_pulse IS NOT NULL
        ) AS heart_pulse,
        argMinIf(
            ranked.temperature_c,
            ranked.priority,
            ranked.temperature_c IS NOT NULL
        ) AS temperature_c,
        best.source_name AS source_name,
        arraySort(groupUniqArray(ranked.provider_id)) AS source_providers,
        max(ranked.source_refreshed_at) AS source_refreshed_at
    FROM best
    INNER JOIN final_groups
        ON final_groups.group_id = best.group_id
        AND final_groups.user_id = best.user_id
    INNER JOIN ranked
        ON ranked.id = final_groups.measurement_id
    GROUP BY
        best.id,
        best.provider_id,
        best.user_id,
        best.external_id,
        best.recorded_at,
        best.created_at,
        best.source_name
),

{% if is_incremental() %}
existing_body_measurements AS (
    SELECT
        id,
        provider_id,
        user_id,
        external_id,
        recorded_at,
        created_at,
        weight_kg,
        body_fat_pct,
        muscle_mass_kg,
        bone_mass_kg,
        water_pct,
        bmi,
        height_cm,
        waist_circumference_cm,
        systolic_bp,
        diastolic_bp,
        heart_pulse,
        temperature_c,
        source_name,
        source_providers,
        source_refreshed_at
    FROM {{ this }} FINAL
    WHERE is_deleted = 0
        AND user_id IN (SELECT user_id FROM dirty_users)
),

stale_body_measurements AS (
    SELECT existing_body_measurements.*
    FROM existing_body_measurements
    LEFT JOIN current_body_measurements
        ON current_body_measurements.user_id = existing_body_measurements.user_id
        AND current_body_measurements.id = existing_body_measurements.id
    WHERE current_body_measurements.id IS NULL
),
{% endif %}

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    current_body_measurements.*,
    toUInt8(0) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_body_measurements
CROSS JOIN refresh_clock

{% if is_incremental() %}
UNION ALL

SELECT
    stale_body_measurements.*,
    toUInt8(1) AS is_deleted,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_body_measurements
CROSS JOIN refresh_clock
{% endif %}
