{{ config(
    materialized='incremental',
    incremental_strategy='append',
    full_refresh=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, provider_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH source_provider_state AS (
    SELECT
        user_id,
        provider_id,
        max(changed_at) AS changed_at
    FROM {{ source('analytics', 'provider_change_state') }}
    GROUP BY user_id, provider_id
),

{% if is_incremental() %}
existing_provider_state AS (
    SELECT
        user_id,
        provider_id,
        max(changed_at) AS changed_at
    FROM {{ this }} FINAL
    GROUP BY user_id, provider_id
),
{% endif %}

changed_providers AS (
    SELECT
        source_provider_state.user_id AS user_id,
        source_provider_state.provider_id AS provider_id,
        source_provider_state.changed_at AS changed_at
    FROM source_provider_state
    {% if is_incremental() %}
    LEFT JOIN existing_provider_state
        ON existing_provider_state.user_id = source_provider_state.user_id
        AND existing_provider_state.provider_id = source_provider_state.provider_id
    WHERE existing_provider_state.provider_id IS NULL
        OR source_provider_state.changed_at > existing_provider_state.changed_at
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    changed_providers.user_id AS user_id,
    changed_providers.provider_id AS provider_id,
    changed_providers.changed_at AS changed_at,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM changed_providers
CROSS JOIN refresh_clock
