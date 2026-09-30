{% macro apple_health_workout_revisions(activity_refresh_scoped) %}
    -- Compare siblings outside the requested group and before lifecycle filtering.
    SELECT
        id,
        row_number() OVER (
            PARTITION BY user_id, trim(BOTH ' ' FROM JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncIdentifier'))
            ORDER BY
                if(
                    match(JSON_VALUE(coalesce(raw, '{}'), '$.metadata.HKMetadataKeySyncVersion'), '^[0-9]+$'),
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
