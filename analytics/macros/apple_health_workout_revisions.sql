{% macro apple_health_workout_revisions(activity_refresh_scoped) %}
    -- Compare siblings outside the requested group and before lifecycle filtering.
    SELECT
        id,
        row_number() OVER (
            PARTITION BY user_id, trim(BOTH ' ' FROM JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier'))
            ORDER BY
                if(
                    match(JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncVersion'), '^[0-9]{1,19}$')
                    AND toUInt64OrZero(JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncVersion')) <= 9223372036854775807,
                    toInt64OrZero(JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncVersion')),
                    0
                ) DESC,
                created_at DESC,
                toString(id) DESC
        ) AS revision_rank
    FROM {{ source('postgres_fitness', 'activity') }} FINAL
    WHERE _peerdb_is_deleted = 0
        AND provider_id = 'apple_health'
        AND trim(BOTH ' ' FROM JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier')) != ''
        {% if activity_refresh_scoped %}
        AND user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        {% endif %}
{% endmacro %}

{% macro apple_health_workout_refresh_ids() %}
    (
        SELECT arrayConcat(groupArray(sibling.id), groupArray(sibling.group_id))
        FROM {{ source('postgres_fitness', 'activity') }} AS sibling FINAL
        WHERE sibling._peerdb_is_deleted = 0
            AND sibling.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
            AND sibling.provider_id = 'apple_health'
            AND trim(BOTH ' ' FROM JSON_VALUE(coalesce(sibling.raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier')) != ''
            AND trim(BOTH ' ' FROM JSON_VALUE(coalesce(sibling.raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier')) IN (
                SELECT trim(BOTH ' ' FROM JSON_VALUE(coalesce(requested.raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier'))
                FROM {{ source('postgres_fitness', 'activity') }} AS requested FINAL
                WHERE requested._peerdb_is_deleted = 0
                    AND requested.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
                    AND requested.provider_id = 'apple_health'
                    AND (
                        requested.id IN {{ activity_refresh_requested_ids() }}
                        OR requested.group_id IN {{ activity_refresh_requested_ids() }}
                    )
            )
    )
{% endmacro %}
