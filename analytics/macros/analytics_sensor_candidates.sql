{% macro analytics_sensor_candidates() %}
analytics_original_keys AS (
    SELECT user_id, arrayJoin(if(channel = 'heart_rate', ['heart_rate', 'rr_interval_ms'], [channel])) AS channel, recorded_at
    FROM analytics_keys
),
analytics_candidates AS (
    SELECT source_id FROM {{ source('analytics', 'source_placement') }}
    WHERE (user_id, channel, recorded_at) IN (SELECT user_id, channel, recorded_at FROM analytics_original_keys)
    GROUP BY source_id
    UNION DISTINCT
    SELECT id AS source_id FROM {{ source('ingest', 'metric_stream_current') }}
    WHERE (user_id, channel, recorded_at) IN (SELECT user_id, channel, recorded_at FROM analytics_original_keys)
    GROUP BY id
    UNION DISTINCT
    SELECT source_id FROM analytics_effects GROUP BY source_id
),
analytics_structural_versions AS (
    SELECT source_id, source_version, ingested_at,
        groupUniqArray(2)(user_id) AS owners,
        groupUniqArray(2)(tuple(user_id, provider_id, source_version, generation, channel,
            recorded_at, ingested_at, activity_id, deleted)) AS placements
    FROM {{ source('analytics', 'source_placement') }}
    WHERE source_id IN (SELECT source_id FROM analytics_candidates)
    GROUP BY source_id, source_version, ingested_at
),
analytics_resolved AS (
    SELECT source_id, groupUniqArrayArray(2)(owners) AS owners,
        argMax(placements, tuple(source_version, ingested_at)) AS placements
    FROM analytics_structural_versions GROUP BY source_id
),
analytics_raw_locations AS (
    SELECT * FROM {{ source('ingest', 'metric_stream_current') }}
    WHERE activity_id IS null AND (user_id, channel, recorded_at, id) IN (
        SELECT placements[1].1, placements[1].5, placements[1].6, source_id
        FROM analytics_resolved WHERE isNull(placements[1].8)
    )
    UNION ALL
    SELECT * FROM {{ source('ingest', 'metric_stream_current') }}
    WHERE activity_id IS NOT null AND (user_id, activity_id, channel, recorded_at, id) IN (
        SELECT placements[1].1, assumeNotNull(placements[1].8), placements[1].5, placements[1].6, source_id
        FROM analytics_resolved WHERE isNotNull(placements[1].8)
    )
),
analytics_payloads AS (
    SELECT id, groupUniqArray(2)(tuple(id, activity_id, user_id, recorded_at, channel,
        provider_id, external_id, device_id, source_type, scalar, vector, point,
        metadata, ingested_at, is_deleted, version, generation)) AS payload
    FROM analytics_raw_locations
    WHERE (id, toUInt64(version), ingested_at) IN (
        SELECT source_id, placements[1].3, placements[1].7 FROM analytics_resolved
    )
    GROUP BY id
),
analytics_checked AS (
    SELECT candidates.source_id AS source_id, resolved.owners AS owners,
        resolved.placements AS placements, payloads.payload AS payload
    FROM analytics_candidates AS candidates
    LEFT JOIN analytics_resolved AS resolved ON candidates.source_id = resolved.source_id
    LEFT JOIN analytics_payloads AS payloads ON candidates.source_id = payloads.id
),
analytics_candidate_check AS (
    SELECT
        throwIf(countIf(length(owners) != 1) != 0, 'Missing or conflicting global owner') AS owner_check,
        throwIf(countIf(length(placements) != 1) != 0, 'Missing or ambiguous global placement') AS placement_check,
        throwIf(countIf(length(payload) != 1) != 0, 'Missing or ambiguous exact raw payload') AS payload_check,
        throwIf(countIf(tuple(payload[1].3, payload[1].6, toUInt64(payload[1].16), payload[1].17,
            payload[1].5, toDateTime64(payload[1].4, 9), payload[1].14,
            ifNull(toString(payload[1].2), ''), toUInt8(payload[1].15)) !=
            tuple(placements[1].1, placements[1].2, placements[1].3, placements[1].4,
                placements[1].5, placements[1].6, placements[1].7,
                ifNull(toString(placements[1].8), ''), placements[1].9)) != 0,
            'Raw payload does not match global structural placement') AS structure_check
    FROM analytics_checked
),
analytics_current_raw AS (
    SELECT source_id AS id, payload[1].2 AS activity_id, payload[1].3 AS user_id,
        payload[1].4 AS recorded_at, payload[1].5 AS original_channel,
        if(payload[1].5 = 'rr_interval_ms', 'heart_rate', payload[1].5) AS channel,
        payload[1].6 AS provider_id, payload[1].7 AS source_external_id,
        payload[1].8 AS device_id, payload[1].9 AS source_type,
        payload[1].10 AS raw_scalar, payload[1].13 AS metadata, payload[1].14 AS ingested_at,
        payload[1].15 AS raw_deleted, payload[1].16 AS source_version
    FROM analytics_checked
    WHERE (SELECT owner_check + placement_check + payload_check + structure_check FROM analytics_candidate_check) = 0
),
analytics_historical_samples AS (
    SELECT source_id, user_id, provider_id,
        if(channel = 'rr_interval_ms', 'heart_rate', channel) AS normalized_channel, recorded_at
    FROM {{ source('analytics', 'source_placement') }}
    WHERE source_id IN (SELECT source_id FROM analytics_candidates)
        AND (user_id, channel, recorded_at) IN (SELECT user_id, channel, recorded_at FROM analytics_original_keys)
    GROUP BY source_id, user_id, provider_id, normalized_channel, recorded_at
),
analytics_sensor_rows AS (
    SELECT raw.id AS id, history.user_id AS user_id, history.provider_id AS provider_id,
        toDateTime64(history.recorded_at, 6, 'UTC') AS recorded_at, history.normalized_channel AS channel,
        (history.user_id, history.provider_id, history.normalized_channel, history.recorded_at)
            = (raw.user_id, raw.provider_id, raw.channel, raw.recorded_at) AS is_current,
        if(is_current, raw.activity_id, NULL) AS activity_id,
        if(is_current, raw.source_external_id, NULL) AS source_external_id,
        if(is_current, raw.device_id, NULL) AS device_id,
        if(is_current, raw.source_type, NULL) AS source_type,
        if(is_current, raw.metadata, '') AS metadata,
        is_current AND raw.original_channel = 'rr_interval_ms' AS derived_heart_rate,
        if(NOT is_current, 0, if(raw.original_channel = 'rr_interval_ms',
            if(coalesce(raw.raw_scalar, 0) > 0 AND isFinite(coalesce(raw.raw_scalar, 0)),
                toFloat32(60000.0 / nullIf(raw.raw_scalar, 0)), 0), coalesce(raw.raw_scalar, 0))) AS scalar,
        toInt8(NOT is_current OR raw.raw_deleted != 0 OR raw.raw_scalar IS null
            OR (raw.original_channel = 'rr_interval_ms'
                AND NOT (coalesce(raw.raw_scalar, 0) > 0 AND isFinite(coalesce(raw.raw_scalar, 0))))) AS is_deleted,
        raw.ingested_at AS ingested_at, raw.source_version AS source_version
    FROM analytics_historical_samples AS history
    INNER JOIN analytics_current_raw AS raw ON history.source_id = raw.id
    WHERE history.normalized_channel IN (
        'heart_rate', 'power', 'speed', 'cadence', 'altitude', 'grade', 'distance', 'temperature',
        'left_right_balance', 'left_torque_effectiveness', 'right_torque_effectiveness',
        'left_pedal_smoothness', 'right_pedal_smoothness', 'stance_time',
        'vertical_oscillation', 'ground_contact_time', 'stride_length'
    )
),
{% endmacro %}
