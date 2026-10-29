{% set activity_refresh_scoped = activity_refresh_scope_enabled() %}
{% set activity_step_cadence_repair_scoped = var('activity_step_cadence_repair_activity_ids', none) is not none %}
{% set activity_step_cadence_batch_size = var('activity_step_cadence_batch_size', 100) %}

{{ config(
    materialized='incremental',
    incremental_strategy='append',
    full_refresh=false,
    engine='ReplacingMergeTree(refresh_version)',
    order_by='(user_id, activity_id)',
    query_settings={'max_threads': 1, 'join_use_nulls': 1, 'enable_materialized_cte': 1}
) }}

WITH
{% if activity_refresh_scoped %}
{{ activity_refresh_scope_ctes() }}
{% endif %}
groups AS MATERIALIZED (
    SELECT * FROM {{ ref('deduped_activities') }} FINAL
),
live_runs AS MATERIALIZED (
    SELECT * FROM groups
    WHERE is_deleted = 0 AND canonical_type = 'running'
),
current_mappings AS MATERIALIZED (
    SELECT
        g.user_id AS user_id,
        g.activity_id AS activity_id,
        s.activity_id AS member_id,
        lower(replaceRegexpOne(assumeNotNull(s.external_id), '^hk:workout:', '')) AS workout_uuid,
        s.started_at AS member_start,
        s.ended_at AS member_end,
        s.source_name AS source_name,
        g.started_at AS group_start,
        g.ended_at AS group_end
    FROM live_runs AS g
    ARRAY JOIN g.member_activity_ids AS member_id
    INNER JOIN {{ ref('activity_source_records') }} AS s FINAL
        ON s.activity_id = member_id AND s.user_id = g.user_id AND s.group_id = g.activity_id
    WHERE s.is_deleted = 0 AND s.provider_id = 'apple_health' AND s.canonical_type = 'running'
        AND s.external_id IS NOT NULL
),
-- Routine source refreshed_at values are build clocks, not lifecycle evidence.
mapping_signatures AS MATERIALIZED (
    SELECT
        user_id,
        toString(cityHash64(toString(arraySort(groupArray(tuple(
        activity_id, member_id, workout_uuid, member_start, member_end, source_name, group_start, group_end
    )))))) AS mapping_signature
    FROM current_mappings
    GROUP BY user_id
),
provider_rules AS MATERIALIZED (
    SELECT
        provider_id,
        channel,
        priority
    FROM {{ source('postgres_fitness', 'sensor_provider_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0 AND channel = 'cadence'
),
device_rules AS MATERIALIZED (
    SELECT
        provider_id,
        channel,
        source_name_pattern,
        priority
    FROM {{ source('postgres_fitness', 'sensor_device_priority') }} FINAL
    WHERE _peerdb_is_deleted = 0 AND channel = 'cadence'
),
priority_state AS MATERIALIZED (
    SELECT toString(cityHash64(toString(arraySort(groupArray(rule))))) AS priority_signature
    FROM (
        SELECT tuple(provider_id, channel, '', priority) AS rule FROM provider_rules
        UNION ALL
        SELECT tuple(provider_id, channel, source_name_pattern, priority) AS rule FROM device_rules
    )
),
previous AS MATERIALIZED (
    {% if is_incremental() %}
    SELECT * FROM {{ this }} FINAL
    {% else %}
    SELECT
        CAST(NULL, 'Nullable(UUID)') AS user_id,
        CAST(NULL, 'Nullable(UUID)') AS activity_id,
        CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS started_at,
        CAST(NULL, 'Nullable(DateTime64(6, ''UTC''))') AS ended_at,
        toDateTime64(0, 9, 'UTC') AS source_changed_at,
        toDateTime64(0, 9, 'UTC') AS activity_source_refreshed_at,
        '' AS mapping_signature,
'' AS priority_signature,
        0 AS is_deleted,
        toDateTime64(0, 9, 'UTC') AS refreshed_at
    WHERE 0
    {% endif %}
),
candidate_keys AS (
    SELECT
        user_id,
        activity_id
    FROM live_runs
    UNION DISTINCT
    SELECT
        user_id,
        activity_id
    FROM previous
),
candidate_state AS MATERIALIZED (
    SELECT
        k.user_id AS user_id,
        k.activity_id AS activity_id,
        coalesce(g.started_at, p.started_at) AS started_at,
        if(g.activity_id IS NULL, p.ended_at, g.ended_at) AS ended_at,
        least(coalesce(g.started_at, p.started_at), coalesce(p.started_at, g.started_at)) AS scan_start,
        greatest(coalesce(g.ended_at, g.started_at, p.ended_at, p.started_at),
            coalesce(p.ended_at, p.started_at, g.ended_at, g.started_at)) AS scan_end,
        coalesce(g.refreshed_at, p.activity_source_refreshed_at, toDateTime64(0, 9, 'UTC')) AS activity_source_refreshed_at,
        coalesce(m.mapping_signature, toString(cityHash64('[]'))) AS mapping_signature,
        priority_state.priority_signature AS priority_signature,
        toUInt8(g.activity_id IS NULL) AS is_deleted,
        p.activity_id AS previous_id,
        p.source_changed_at AS previous_source_changed_at,
        p.activity_source_refreshed_at AS previous_activity_refreshed_at,
        p.mapping_signature AS previous_mapping_signature,
        p.priority_signature AS previous_priority_signature,
        p.is_deleted AS previous_deleted,
        coalesce(p.refreshed_at, toDateTime64(0, 9, 'UTC')) AS previous_refreshed_at
    FROM candidate_keys AS k
    LEFT JOIN live_runs AS g ON g.user_id = k.user_id AND g.activity_id = k.activity_id
    LEFT JOIN previous AS p ON p.user_id = k.user_id AND p.activity_id = k.activity_id
    LEFT JOIN mapping_signatures AS m ON m.user_id = k.user_id
    CROSS JOIN priority_state
),
candidate_dates AS (
    SELECT
        user_id,
        activity_id,
        addDays(toDate(scan_start), arrayJoin(range(toUInt32(dateDiff('day', toDate(scan_start), toDate(greatest(scan_start, scan_end))) + 1)))) AS recorded_date
    FROM candidate_state
),
raw_watermarks AS (
    SELECT
        d.user_id AS user_id,
        d.activity_id AS activity_id,
        coalesce(max(c.changed_at), toDateTime64(0, 9, 'UTC')) AS source_changed_at
    FROM candidate_dates AS d
    LEFT JOIN {{ source('analytics', 'metric_stream_day_change') }} AS c
        ON c.user_id = d.user_id AND c.recorded_date = d.recorded_date AND c.provider_id = 'apple_health'
    GROUP BY d.user_id, d.activity_id
),
-- Consume each causal input independently; only selected keys advance their state.
dirty_keys AS MATERIALIZED (
    SELECT
        c.*,
        w.source_changed_at AS source_changed_at
    FROM candidate_state AS c
    INNER JOIN raw_watermarks AS w ON w.user_id = c.user_id AND w.activity_id = c.activity_id
    WHERE
        {% if activity_step_cadence_repair_scoped %}
        c.user_id = toUUID('{{ var("activity_refresh_user_id") }}')
            AND c.activity_id IN {{ activity_step_cadence_repair_ids() }}
        {% else %}
        {% if activity_refresh_scoped %}
        c.user_id = toUUID('{{ var("activity_refresh_user_id") }}') AND (
            c.activity_id IN {{ activity_refresh_ids() }} OR c.activity_id IN (
                SELECT activity_id FROM groups
                WHERE user_id = toUUID('{{ var("activity_refresh_user_id") }}')
                    AND hasAny(member_activity_ids, {{ activity_refresh_ids() }})
            )
        )
        {% else %}
        c.previous_id IS NULL OR w.source_changed_at > c.previous_source_changed_at
        OR c.activity_source_refreshed_at > c.previous_activity_refreshed_at
        OR c.mapping_signature != c.previous_mapping_signature
        OR c.priority_signature != c.previous_priority_signature OR c.is_deleted != c.previous_deleted
        {% endif %}
        {% endif %}
    ORDER BY c.previous_refreshed_at, c.user_id, c.activity_id
    LIMIT {{ activity_step_cadence_batch_size }}
),
selected_dates AS MATERIALIZED (
    SELECT DISTINCT
        d.user_id AS user_id,
        d.recorded_date AS recorded_date
    FROM candidate_dates AS d
    INNER JOIN dirty_keys AS k ON k.user_id = d.user_id AND k.activity_id = d.activity_id
),
selected_raw_ids AS (
    SELECT DISTINCT
        user_id,
        id
    FROM {{ source('ingest', 'metric_stream_current') }}
    WHERE provider_id = 'apple_health' AND channel = 'step_count'
        AND (user_id, toDate(recorded_at)) IN (SELECT
        user_id,
        recorded_date
    FROM selected_dates)
),
-- Resolve complete histories for selected IDs before tombstone or validity filters.
raw_latest AS MATERIALIZED (
    SELECT
        user_id,
        id,
        argMax(tuple(recorded_at, scalar, metadata, provider_id, device_id, external_id, is_deleted),
        tuple(version, ingested_at)) AS state
    FROM {{ source('ingest', 'metric_stream_current') }}
    WHERE (user_id, id) IN (SELECT
        user_id,
        id
    FROM selected_raw_ids)
    GROUP BY user_id, id
),
raw_steps AS MATERIALIZED (
    SELECT
        user_id,
        id,
        state.1 AS interval_start,
        state.2 AS steps,
        parseDateTime64BestEffortOrNull(JSONExtractString(state.3, 'interval_end'), 6, 'UTC') AS interval_end,
        state.4 AS provider_id,
        state.5 AS device_id,
        state.6 AS parent_id,
        JSONExtractString(state.3, 'source_bundle') AS bundle,
        arrayDistinct(arrayMap(x -> lower(x), JSONExtract(state.3, 'workout_uuids', 'Array(String)'))) AS workout_uuids
    FROM raw_latest
    WHERE state.7 = 0 AND isFinite(state.2) AND state.2 >= 0
),
-- All current mappings participate, including groups outside the bounded batch.
associations AS MATERIALIZED (
    SELECT
        r.user_id AS user_id,
        r.id AS id,
        uniqExact(m.activity_id) AS group_count,
        any(m.activity_id) AS activity_id,
        max(toUInt8(r.interval_start >= m.member_start AND r.interval_end <= m.member_end
            AND r.interval_start >= m.group_start AND r.interval_end <= m.group_end)) AS contained
    FROM raw_steps AS r
    ARRAY JOIN r.workout_uuids AS workout_uuid
    INNER JOIN current_mappings AS m ON m.user_id = r.user_id AND m.workout_uuid = workout_uuid
    GROUP BY r.user_id, r.id
),
intervals AS MATERIALIZED (
    SELECT
        r.user_id AS user_id,
        a.activity_id AS activity_id,
        r.provider_id AS provider_id,
        r.bundle AS bundle,
        any(r.device_id) AS device_id,
        r.interval_start AS interval_start,
        assumeNotNull(r.interval_end) AS interval_end,
        assumeNotNull(r.steps) AS steps,
        groupUniqArray(r.parent_id) AS parent_ids
    FROM raw_steps AS r
    INNER JOIN associations AS a ON a.user_id = r.user_id AND a.id = r.id
    INNER JOIN dirty_keys AS k ON k.user_id = a.user_id AND k.activity_id = a.activity_id
    WHERE a.group_count = 1 AND a.contained = 1 AND r.interval_end > r.interval_start
        AND r.bundle != '' AND k.is_deleted = 0
    GROUP BY r.user_id, a.activity_id, r.provider_id, r.bundle, r.id, r.parent_id, r.interval_start, r.interval_end, r.steps
),
-- The prior maximum catches nested overlaps; any overlap invalidates this source.
ordered_intervals AS (
    SELECT
        *,
        maxOrNull(interval_end) OVER (
        PARTITION BY user_id, activity_id, provider_id, bundle
        ORDER BY interval_start, interval_end, steps ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_end
    FROM intervals
),
source_totals AS MATERIALIZED (
    SELECT
        user_id,
        activity_id,
        provider_id,
        bundle,
        arraySort(groupUniqArray(device_id)) AS device_names,
        sum(steps) AS observed_steps,
        sum(dateDiff('microsecond', interval_start, interval_end) / 1000000.0) AS observed_seconds,
        count() AS interval_count,
        length(arrayDistinct(arrayFlatten(groupArray(parent_ids)))) AS parent_sample_count,
        min(interval_start) AS first_observed_at,
        max(interval_end) AS last_observed_at
    FROM ordered_intervals
    GROUP BY user_id, activity_id, provider_id, bundle
    HAVING countIf(interval_start < prior_end) = 0
),
source_names AS (
    SELECT
        user_id,
        activity_id,
        provider_id,
        bundle,
        arrayJoin(if(empty(device_names), [CAST(NULL, 'Nullable(String)')], device_names)) AS device_id
    FROM source_totals
),
name_matches AS (
    SELECT
        t.user_id AS user_id,
        t.activity_id AS activity_id,
        t.provider_id AS provider_id,
        t.bundle AS bundle,
        t.device_id AS device_id,
        argMin(tuple(d.priority, d.source_name_pattern),
            tuple(-length(d.source_name_pattern), d.priority, d.source_name_pattern)) AS rule
    FROM source_names AS t INNER JOIN device_rules AS d
        ON d.provider_id = t.provider_id AND coalesce(t.device_id, '') LIKE d.source_name_pattern
    GROUP BY t.user_id, t.activity_id, t.provider_id, t.bundle, t.device_id
),
device_matches AS (
    SELECT
        n.user_id AS user_id,
        n.activity_id AS activity_id,
        n.provider_id AS provider_id,
        n.bundle AS bundle,
        tupleElement(argMin(tuple(n.device_id), tuple(n.rule.1, coalesce(n.device_id, ''), n.rule.2)), 1) AS device_id,
        min(n.rule.1) AS priority
    FROM name_matches AS n
    GROUP BY n.user_id, n.activity_id, n.provider_id, n.bundle
),
ranked_sources AS (
    SELECT
        t.user_id AS user_id,
        t.activity_id AS activity_id,
        t.provider_id AS provider_id,
        t.bundle AS bundle,
        if(d.priority IS NOT NULL, d.device_id, arrayElementOrNull(t.device_names, 1)) AS device_id,
        t.observed_steps AS observed_steps,
        t.observed_seconds AS observed_seconds,
        t.interval_count AS interval_count,
        t.parent_sample_count AS parent_sample_count,
        t.first_observed_at AS first_observed_at,
        t.last_observed_at AS last_observed_at,
        row_number() OVER (PARTITION BY t.user_id, t.activity_id
        ORDER BY coalesce(d.priority, p.priority, 1000), t.observed_seconds DESC, t.provider_id ASC, t.bundle ASC) AS source_rank
    FROM source_totals AS t
    LEFT JOIN device_matches AS d ON d.user_id = t.user_id AND d.activity_id = t.activity_id
        AND d.provider_id = t.provider_id AND d.bundle = t.bundle
    LEFT JOIN provider_rules AS p ON p.provider_id = t.provider_id
),
winners AS (
    SELECT * FROM ranked_sources
    WHERE source_rank = 1
)
SELECT
    assumeNotNull(k.user_id) AS user_id,
    assumeNotNull(k.activity_id) AS activity_id,
    CAST(60.0 * w.observed_steps / nullIf(w.observed_seconds, 0), 'Nullable(Float64)') AS avg_cadence,
    coalesce(w.observed_steps, 0) AS observed_steps,
    coalesce(w.observed_seconds, 0) AS observed_seconds,
    coalesce(w.interval_count, 0) AS interval_count,
    toUInt64(coalesce(w.parent_sample_count, 0)) AS parent_sample_count,
    w.provider_id AS source_provider,
    w.device_id AS source_device,
    w.bundle AS source_bundle,
    w.first_observed_at AS first_observed_at,
    w.last_observed_at AS last_observed_at,
    w.observed_seconds / nullIf(dateDiff('microsecond', k.started_at, k.ended_at) / 1000000.0, 0) AS coverage_fraction,
    k.source_changed_at AS source_changed_at,
    k.activity_source_refreshed_at AS activity_source_refreshed_at,
    k.mapping_signature AS mapping_signature,
    k.priority_signature AS priority_signature,
    k.started_at AS started_at,
    k.ended_at AS ended_at,
    k.is_deleted AS is_deleted,
    toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version,
    now64(9, 'UTC') AS refreshed_at
FROM dirty_keys AS k
LEFT JOIN winners AS w ON w.user_id = k.user_id AND w.activity_id = k.activity_id
WHERE k.user_id IS NOT NULL AND k.activity_id IS NOT NULL
