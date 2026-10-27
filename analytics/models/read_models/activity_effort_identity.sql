{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, source_activity_id, kind, namespace, normalized_value, source_field)',
    query_settings={
        'max_threads': 1,
        'join_use_nulls': 1,
        'enable_materialized_cte': 1
    }
) }}

WITH
{% if activity_refresh_scoped %}
scoped_source_ids AS MATERIALIZED (
    SELECT arrayJoin({{ activity_refresh_ids() }}) AS source_activity_id
    UNION DISTINCT
    SELECT member_activity_id AS source_activity_id
    FROM {{ ref('deduped_activity_members') }} FINAL
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND activity_id IN {{ activity_refresh_ids() }}
    {% if is_incremental() %}
    UNION DISTINCT
    SELECT source_activity_id
    FROM {{ this }} FINAL
    WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND canonical_activity_id IN {{ activity_refresh_ids() }}
    {% endif %}
),
{% endif %}
current_source_members AS MATERIALIZED (
    SELECT
        assumeNotNull(source_records.user_id) AS user_id,
        activity_members.activity_id AS canonical_activity_id,
        source_records.activity_id AS source_activity_id,
        assumeNotNull(source_records.provider_id) AS source_provider,
        source_records.external_id AS source_external_id,
        assumeNotNull(source_records.canonical_type) AS canonical_type,
        source_records.name AS display_name,
        source_records.raw AS raw,
        greatest(
            coalesce(source_records.source_synced_at, toDateTime64('1970-01-01 00:00:00', 9, 'UTC')),
            coalesce(activity_members.source_synced_at, toDateTime64('1970-01-01 00:00:00', 9, 'UTC'))
        ) AS source_refreshed_at
    FROM {{ ref('activity_source_records') }} AS source_records FINAL
    INNER JOIN {{ ref('deduped_activity_members') }} AS activity_members FINAL
        ON activity_members.member_activity_id = source_records.activity_id
        AND activity_members.user_id = source_records.user_id
    WHERE source_records.is_deleted = 0
        AND activity_members.is_deleted = 0
        {% if activity_refresh_scoped %}
        AND source_records.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND source_records.activity_id IN (SELECT source_activity_id FROM scoped_source_ids)
        {% endif %}
),

{% if is_incremental() %}
target_source_state AS MATERIALIZED (
    SELECT
        existing_identities.user_id AS user_id,
        existing_identities.source_activity_id AS source_activity_id,
        max(existing_identities.source_refreshed_at) AS source_refreshed_at,
        argMax(existing_identities.canonical_activity_id, existing_identities.refresh_version) AS canonical_activity_id,
        countIf(existing_identities.is_deleted = 0) = 0 AS has_no_live_identity
    FROM {{ this }} AS existing_identities FINAL
    {% if activity_refresh_scoped %}
    WHERE existing_identities.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
        AND existing_identities.source_activity_id IN (SELECT source_activity_id FROM scoped_source_ids)
    {% endif %}
    GROUP BY existing_identities.user_id, existing_identities.source_activity_id
),

changed_source_keys AS MATERIALIZED (
    SELECT
        current_sources.user_id AS user_id,
        current_sources.source_activity_id AS source_activity_id,
        current_sources.source_refreshed_at AS source_refreshed_at
    FROM current_source_members AS current_sources
    LEFT JOIN target_source_state
        ON target_source_state.user_id = current_sources.user_id
        AND target_source_state.source_activity_id = current_sources.source_activity_id
    WHERE target_source_state.source_activity_id IS null
        OR target_source_state.has_no_live_identity
        OR current_sources.source_refreshed_at != target_source_state.source_refreshed_at
        OR current_sources.canonical_activity_id != target_source_state.canonical_activity_id

    UNION DISTINCT

    SELECT
        existing_source_state.user_id AS user_id,
        existing_source_state.source_activity_id AS source_activity_id,
        coalesce(current_sources.source_refreshed_at, now64(9)) AS source_refreshed_at
    FROM target_source_state AS existing_source_state
    LEFT JOIN current_source_members AS current_sources
        ON current_sources.user_id = existing_source_state.user_id
        AND current_sources.source_activity_id = existing_source_state.source_activity_id
    WHERE existing_source_state.has_no_live_identity = 0
        AND (
            current_sources.source_activity_id IS null
            OR current_sources.source_refreshed_at != existing_source_state.source_refreshed_at
            OR current_sources.canonical_activity_id != existing_source_state.canonical_activity_id
        )
),
{% else %}
changed_source_keys AS MATERIALIZED (
    SELECT
        user_id,
        source_activity_id,
        source_refreshed_at
    FROM current_source_members
),
{% endif %}

identity_field_mapping AS (
    SELECT arrayJoin([
        tuple('provider_workout', 'pelotonClassId'),
        tuple('provider_workout', 'templateId'),
        tuple('provider_workout', 'workoutTemplateId'),
        tuple('provider_workout', 'classId'),
        tuple('provider_route', 'routeId'),
        tuple('provider_route', 'courseId'),
        tuple('segment', 'segmentId'),
        tuple('standardized_test', 'standardizedTestId'),
        tuple('standardized_test', 'testId')
    ]) AS mapping
),

raw_identity_candidates AS (
    SELECT
        current_sources.user_id AS user_id,
        current_sources.canonical_activity_id AS canonical_activity_id,
        current_sources.source_activity_id AS source_activity_id,
        current_sources.source_provider AS source_provider,
        current_sources.source_external_id AS source_external_id,
        current_sources.display_name AS display_name,
        current_sources.source_refreshed_at AS source_refreshed_at,
        mapping.1 AS kind,
        current_sources.source_provider AS namespace,
        mapping.2 AS source_field,
        trim(BOTH ' ' FROM JSONExtractString(coalesce(current_sources.raw, ''), mapping.2)) AS value,
        'exact_explicit_raw_identity_v1' AS method,
        'exact' AS strength
    FROM current_source_members AS current_sources
    INNER JOIN changed_source_keys
        ON changed_source_keys.user_id = current_sources.user_id
        AND changed_source_keys.source_activity_id = current_sources.source_activity_id
    CROSS JOIN identity_field_mapping
),

name_identity_candidates AS (
    SELECT
        current_sources.user_id AS user_id,
        current_sources.canonical_activity_id AS canonical_activity_id,
        current_sources.source_activity_id AS source_activity_id,
        current_sources.source_provider AS source_provider,
        current_sources.source_external_id AS source_external_id,
        current_sources.display_name AS display_name,
        current_sources.source_refreshed_at AS source_refreshed_at,
        'activity_name' AS kind,
        current_sources.canonical_type AS namespace,
        'name' AS source_field,
        trim(BOTH ' ' FROM assumeNotNull(current_sources.display_name)) AS value,
        'weak_normalized_activity_name' AS method,
        'weak_similarity' AS strength
    FROM current_source_members AS current_sources
    INNER JOIN changed_source_keys
        ON changed_source_keys.user_id = current_sources.user_id
        AND changed_source_keys.source_activity_id = current_sources.source_activity_id
    WHERE current_sources.display_name IS NOT null
),

identity_candidates AS (
    SELECT
        user_id,
        canonical_activity_id,
        source_activity_id,
        source_provider,
        source_external_id,
        display_name,
        source_refreshed_at,
        kind,
        namespace,
        source_field,
        value,
        method,
        strength
    FROM raw_identity_candidates
    WHERE value != ''

    UNION ALL

    SELECT
        user_id,
        canonical_activity_id,
        source_activity_id,
        source_provider,
        source_external_id,
        display_name,
        source_refreshed_at,
        kind,
        namespace,
        source_field,
        value,
        method,
        strength
    FROM name_identity_candidates
    WHERE value != ''
),

current_identity_rows AS MATERIALIZED (
    SELECT
        user_id,
        canonical_activity_id,
        source_activity_id,
        source_provider,
        source_external_id,
        kind,
        namespace,
        value,
        lowerUTF8(replaceRegexpAll(value, '\\s+', ' ')) AS normalized_value,
        display_name,
        strength,
        method,
        source_field,
        map(
            'mappingVersion', 'v1',
            'rawField', source_field,
            'rawValue', value,
            'sourceActivityId', toString(source_activity_id),
            'sourceProvider', source_provider,
            'sourceExternalId', coalesce(source_external_id, '')
        ) AS evidence,
        source_refreshed_at
    FROM identity_candidates
),

{% if is_incremental() %}
existing_identity_rows AS (
    SELECT
        existing_identities.user_id AS user_id,
        existing_identities.canonical_activity_id AS canonical_activity_id,
        existing_identities.source_activity_id AS source_activity_id,
        existing_identities.source_provider AS source_provider,
        existing_identities.source_external_id AS source_external_id,
        existing_identities.kind AS kind,
        existing_identities.namespace AS namespace,
        existing_identities.value AS value,
        existing_identities.normalized_value AS normalized_value,
        existing_identities.display_name AS display_name,
        existing_identities.strength AS strength,
        existing_identities.method AS method,
        existing_identities.source_field AS source_field,
        existing_identities.evidence AS evidence,
        existing_identities.source_refreshed_at AS source_refreshed_at
    FROM {{ this }} AS existing_identities FINAL
    INNER JOIN changed_source_keys
        ON changed_source_keys.user_id = existing_identities.user_id
        AND changed_source_keys.source_activity_id = existing_identities.source_activity_id
    WHERE existing_identities.is_deleted = 0
),

stale_identity_rows AS (
    SELECT
        existing_identities.user_id AS user_id,
        existing_identities.canonical_activity_id AS canonical_activity_id,
        existing_identities.source_activity_id AS source_activity_id,
        existing_identities.source_provider AS source_provider,
        existing_identities.source_external_id AS source_external_id,
        existing_identities.kind AS kind,
        existing_identities.namespace AS namespace,
        existing_identities.value AS value,
        existing_identities.normalized_value AS normalized_value,
        existing_identities.display_name AS display_name,
        existing_identities.strength AS strength,
        existing_identities.method AS method,
        existing_identities.source_field AS source_field,
        existing_identities.evidence AS evidence,
        existing_identities.source_refreshed_at AS source_refreshed_at,
        changed_source_keys.source_refreshed_at AS next_source_refreshed_at
    FROM existing_identity_rows AS existing_identities
    LEFT ANTI JOIN current_identity_rows
        ON current_identity_rows.user_id = existing_identities.user_id
        AND current_identity_rows.source_activity_id = existing_identities.source_activity_id
        AND current_identity_rows.kind = existing_identities.kind
        AND current_identity_rows.namespace = existing_identities.namespace
        AND current_identity_rows.normalized_value = existing_identities.normalized_value
        AND current_identity_rows.source_field = existing_identities.source_field
    INNER JOIN changed_source_keys
        ON changed_source_keys.user_id = existing_identities.user_id
        AND changed_source_keys.source_activity_id = existing_identities.source_activity_id
),
{% endif %}

refresh_clock AS (
    SELECT
        toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
        now64(9) AS refreshed_at
)

SELECT
    user_id,
    canonical_activity_id,
    source_activity_id,
    source_provider,
    source_external_id,
    kind,
    namespace,
    value,
    normalized_value,
    display_name,
    strength,
    method,
    source_field,
    evidence,
    source_refreshed_at,
    refresh_clock.refresh_version AS refresh_version,
    0 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM current_identity_rows
CROSS JOIN refresh_clock

{% if is_incremental() %}
UNION ALL

SELECT
    user_id,
    canonical_activity_id,
    source_activity_id,
    source_provider,
    source_external_id,
    kind,
    namespace,
    value,
    normalized_value,
    display_name,
    strength,
    method,
    source_field,
    evidence,
    greatest(source_refreshed_at, next_source_refreshed_at) AS source_refreshed_at,
    refresh_clock.refresh_version AS refresh_version,
    1 AS is_deleted,
    refresh_clock.refreshed_at AS refreshed_at
FROM stale_identity_rows
CROSS JOIN refresh_clock
{% endif %}
