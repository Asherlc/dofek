{{ config(materialized='view') }}
{% set target_user_ids = '{target_user_ids:Array(UUID)}' %}

WITH pace_pending AS (
    {{ activity_sensor_dirty_keys('speed', ref('activity_pace_curve'), batch_size=none, read_prior_state=true, required_durations=activity_pace_durations(), target_user_ids=target_user_ids) }}
),

heart_rate_pending AS (
    {{ activity_sensor_dirty_keys('heart_rate', ref('activity_heart_rate_distribution'), batch_size=none, read_prior_state=true, target_user_ids=target_user_ids) }}
),

users AS (
    SELECT user_id FROM {{ ref('deduped_activities') }} FINAL
    WHERE user_id IN {{ target_user_ids }}
    UNION DISTINCT
    SELECT user_id FROM {{ ref('activity_pace_curve') }} FINAL
    WHERE user_id IN {{ target_user_ids }}
    UNION DISTINCT
    SELECT user_id FROM {{ ref('activity_heart_rate_distribution') }} FINAL
    WHERE user_id IN {{ target_user_ids }}
),

pending AS (
    SELECT
        user_id,
        'activity_pace_curve' AS model,
        activity_id,
        source_activity_version,
        source_sensor_version,
        processing_age
    FROM pace_pending
    UNION ALL
    SELECT
        user_id,
        'activity_heart_rate_distribution' AS model,
        activity_id,
        source_activity_version,
        source_sensor_version,
        processing_age
    FROM heart_rate_pending
),

pending_by_user AS (
    SELECT
        user_id,
        model,
        CAST(
            arrayMap(
                key -> tuple(key.1, toString(key.2), toString(key.3), toString(key.4)),
                arraySort(
                    key -> (key.4, greatest(key.2, key.3), key.1),
                    groupArray(tuple(activity_id, source_activity_version, source_sensor_version, processing_age))
                )
            ),
            'Array(Tuple(activity_id UUID, source_activity_version String, source_sensor_version String, processing_age String))'
        ) AS pending_keys
    FROM pending
    GROUP BY user_id, model
),

invalid_pace_inventory AS (
    SELECT
        user_id,
        arraySort(groupUniqArray(activity_id)) AS activity_ids
    FROM {{ ref('activity_pace_curve') }} FINAL
    WHERE duration_seconds NOT IN ({{ activity_pace_durations() | join(', ') }})
        AND user_id IN {{ target_user_ids }}
    GROUP BY user_id
),

models AS (
    SELECT arrayJoin(['activity_pace_curve', 'activity_heart_rate_distribution']) AS model
)

SELECT
    users.user_id AS user_id,
    models.model AS model,
    CAST(
        coalesce(pending_by_user.pending_keys, []),
        'Array(Tuple(activity_id UUID, source_activity_version String, source_sensor_version String, processing_age String))'
    ) AS pending_keys,
    if(models.model = 'activity_pace_curve', coalesce(invalid_pace_inventory.activity_ids, []), []) AS invalid_duration_keys
FROM users
CROSS JOIN models
LEFT JOIN pending_by_user ON pending_by_user.user_id = users.user_id AND pending_by_user.model = models.model
LEFT JOIN invalid_pace_inventory ON invalid_pace_inventory.user_id = users.user_id
SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1
