{% set provider_change_watermark_lookback_hours = var('provider_change_watermark_lookback_hours', 6) %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, provider_id)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1
    }
) }}

WITH
{% if is_incremental() %}
watermark AS (
    SELECT max(changed_at) AS max_changed_at
    FROM {{ this }} FINAL
),

scan_cutoff AS (
    SELECT
        coalesce(
            max_changed_at,
            toDateTime64('1970-01-01 00:00:00', 9, 'UTC')
        ) - INTERVAL {{ provider_change_watermark_lookback_hours }} HOUR AS cutoff_at
    FROM watermark
),

existing_provider_watermarks AS (
    SELECT
        user_id,
        provider_id,
        max(changed_at) AS changed_at
    FROM {{ this }} FINAL
    GROUP BY
        user_id,
        provider_id
),
{% endif %}

source_provider_refreshes AS (
    SELECT
        user_id,
        id AS provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'provider') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'daily_metrics') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'sleep_session') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(ingested_at) AS source_refreshed_at
    FROM {{ source('ingest', 'metric_stream') }}
    {% if is_incremental() %}
    WHERE ingested_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM analytics.body_measurement_sample FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'food_entry') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'health_event') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'lab_panel') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'lab_result') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id

    UNION ALL
    SELECT
        user_id,
        provider_id,
        max(_peerdb_synced_at) AS source_refreshed_at
    FROM {{ source('postgres_fitness', 'journal_entry') }} FINAL
    {% if is_incremental() %}
    WHERE _peerdb_synced_at > (SELECT cutoff_at FROM scan_cutoff)
    {% endif %}
    GROUP BY user_id, provider_id
),

recent_provider_changes AS (
    SELECT
        user_id,
        provider_id,
        max(source_refreshed_at) AS source_changed_at
    FROM source_provider_refreshes
    GROUP BY user_id, provider_id
),

changed_providers AS (
    SELECT
        recent_provider_changes.user_id AS user_id,
        recent_provider_changes.provider_id AS provider_id,
        recent_provider_changes.source_changed_at AS changed_at
    FROM recent_provider_changes
    {% if is_incremental() %}
    LEFT JOIN existing_provider_watermarks
        ON existing_provider_watermarks.user_id = recent_provider_changes.user_id
        AND existing_provider_watermarks.provider_id = recent_provider_changes.provider_id
    WHERE existing_provider_watermarks.provider_id IS NULL
        OR recent_provider_changes.source_changed_at > existing_provider_watermarks.changed_at
    {% endif %}
),

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    assumeNotNull(changed_providers.user_id) AS user_id,
    assumeNotNull(changed_providers.provider_id) AS provider_id,
    changed_providers.changed_at AS changed_at,
    refresh_clock.refresh_version AS refresh_version,
    refresh_clock.refreshed_at AS refreshed_at
FROM changed_providers
CROSS JOIN refresh_clock
WHERE changed_providers.user_id IS NOT NULL
    AND changed_providers.provider_id IS NOT NULL
