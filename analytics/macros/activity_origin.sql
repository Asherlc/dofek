{% macro activity_origin() %}
origin_labels AS (
    SELECT
        user_id,
        group_id,
        activity_id,
        provider_id,
        external_id,
        source_name,
        lowerUTF8(trim(BOTH ' ' FROM coalesce(source_name, ''))) AS source_label,
        lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(coalesce(raw, '{}'), 'sourceBundle'))) AS source_bundle,
        lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(coalesce(raw, '{}'), 'device_name'))) AS raw_device_label,
        lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(coalesce(raw, '{}'), 'platform'))) AS platform_label,
        lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(coalesce(raw, '{}'), 'deviceType'))) AS device_type_label,
        if(provider_id = 'peloton'
            AND lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(coalesce(raw, '{}'), 'platform'))) = 'whoop'
            AND lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(coalesce(raw, '{}'), 'deviceType'))) = 'whoop'
            AND match(lowerUTF8(coalesce(external_id, '')), '^([0-9a-f]{32}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$'),
            'whoop', NULL) AS copy_provider
    FROM ranked
),
origin_hints AS (
    SELECT
        *,
        provider_id = 'apple_health'
        AND match(replaceAll(source_label, unhex('C2A0'), ' '), '(^|[[:space:]])apple[[:space:]]+watch[[:space:]]*$')
            AS is_watch_recording,
        provider_id = 'peloton' AND platform_label = 'home_bike'
        AND device_type_label IN ('bike', 'home_bike_plus') AS is_native_peloton_recording,
        multiIf(
            provider_id = 'apple_health',
            transform(source_label,
                ['strava', 'garmin', 'garmin connect', 'wahoo', 'zwift', 'peloton', 'trainerroad', 'whoop', 'strong', 'hang ten', 'hang ten training'],
                ['strava', 'garmin', 'garmin', 'wahoo', 'zwift', 'peloton', 'trainerroad', 'whoop', 'strong-csv', 'hang-ten', 'hang-ten'], ''),
            provider_id = 'strava' AND match(source_label, '^garmin edge( |$)'), 'garmin',
            provider_id = 'strava' AND match(source_label, '^wahoo elemnt( |$)'), 'wahoo',
            provider_id = 'strava' AND source_label = 'peloton bike', 'peloton',
            ''
        ) AS label_provider,
        if(provider_id = 'apple_health' AND source_bundle = 'com.strava.strava', 'strava', '') AS bundle_provider,
        multiIf(
            provider_id = 'strava' AND match(raw_device_label, '^garmin edge( |$)'), 'garmin',
            provider_id = 'strava' AND match(raw_device_label, '^wahoo elemnt( |$)'), 'wahoo',
            provider_id = 'strava' AND raw_device_label = 'peloton bike', 'peloton',
            ''
        ) AS device_provider
    FROM origin_labels
),
origin_members AS (
    SELECT
        *,
        coalesce(copy_provider, nullIf(bundle_provider, ''), nullIf(label_provider, ''), nullIf(device_provider, '')) AS upstream_provider,
        length(arrayDistinct(arrayFilter(hint -> isNotNull(hint) AND hint != '', [copy_provider, label_provider, bundle_provider, device_provider]))) > 1
        OR (is_watch_recording AND bundle_provider != '')
        OR (provider_id = 'strava' AND source_label != '' AND raw_device_label != '' AND source_label != raw_device_label)
            AS conflicting,
        multiIf(copy_provider IS NOT NULL, 'external_id', bundle_provider != '', 'raw.sourceBundle', label_provider != '', 'source_name', 'raw.device_name') AS evidence_field,
        multiIf(copy_provider IS NOT NULL, lowerUTF8(replaceAll(external_id, '-', '')), bundle_provider != '', source_bundle, label_provider != '', source_label, raw_device_label) AS evidence_value
    FROM origin_hints
),
origin_matches AS (
    SELECT
        downstream.user_id AS user_id,
        downstream.group_id AS group_id,
        downstream.activity_id AS downstream_id,
        any(upstream.activity_id) AS upstream_id,
        any(downstream.evidence_field) AS evidence_field,
        any(downstream.evidence_value) AS evidence_value
    FROM origin_members AS downstream
    INNER JOIN origin_members AS upstream
        ON upstream.user_id = downstream.user_id
        AND upstream.group_id = downstream.group_id
        AND upstream.provider_id = downstream.upstream_provider
        AND upstream.activity_id != downstream.activity_id
    WHERE NOT downstream.conflicting
        AND (downstream.copy_provider IS NULL
            OR lowerUTF8(replaceAll(upstream.external_id, '-', '')) = lowerUTF8(replaceAll(downstream.external_id, '-', '')))
        AND (downstream.provider_id != 'strava'
            OR upstream.source_label = ''
            OR upstream.source_label = coalesce(nullIf(downstream.source_label, ''), downstream.raw_device_label))
    GROUP BY downstream.user_id, downstream.group_id, downstream.activity_id
    HAVING count() = 1
),
origin_group_edges AS (
    SELECT
        user_id,
        group_id,
        arraySort(groupArray(tuple(upstream_id, downstream_id, evidence_field, evidence_value))) AS edges
    FROM origin_matches
    GROUP BY user_id, group_id
),
origin_graphs AS (
    SELECT
        members.user_id AS user_id,
        members.group_id AS group_id,
        arraySort(groupArray(members.activity_id)) AS member_ids,
        arraySort(groupArrayIf(members.activity_id, members.provider_id = 'strong-csv')) AS strong_export_ids,
        arraySort(groupArrayIf(members.activity_id, members.provider_id = 'apple_health' AND members.source_label = 'strong')) AS strong_health_ids,
        arraySort(groupArrayIf(members.activity_id, members.provider_id = 'apple_health' AND members.source_label IN ('hang ten', 'hang ten training'))) AS hang_ten_ids,
        arraySort(groupArrayIf(members.activity_id, members.is_watch_recording)) AS apple_watch_ids,
        arraySort(groupArrayIf(members.activity_id, members.is_native_peloton_recording)) AS native_peloton_ids,
        arraySort(groupArrayIf(members.activity_id, members.provider_id IN ('kaya', 'kaya-export'))) AS kaya_ids,
        max(members.conflicting) AS conflicting,
        coalesce(any(origin_group_edges.edges), CAST([], 'Array(Tuple(UUID, UUID, String, String))')) AS edges
    FROM origin_members AS members
    LEFT JOIN origin_group_edges
        ON members.user_id = origin_group_edges.user_id AND members.group_id = origin_group_edges.group_id
    GROUP BY members.user_id, members.group_id
),
origin_graph_members AS (
    SELECT
        *,
        arrayJoin(member_ids) AS member_id
    FROM origin_graphs
),
origin_reachability AS (
    SELECT
        *,
        arrayFold(
            (reached, iteration) -> arrayDistinct(arrayConcat(reached,
                arrayMap(edge -> edge.2, arrayFilter(edge -> edge.1 = member_id OR has(reached, edge.1), edges))
            )),
            range(length(member_ids)),
            CAST([], 'Array(UUID)')
        ) AS reached
    FROM origin_graph_members
),
origin_decisions AS (
    SELECT
        user_id,
        group_id,
        any(member_ids) AS group_member_ids,
        any(edges) AS group_edges,
        any(arrayConcat(if(length(strong_export_ids) > 0, strong_export_ids, strong_health_ids), hang_ten_ids, apple_watch_ids, native_peloton_ids, kaya_ids)) AS initiating_origins,
        max(conflicting) OR max(has(reached, member_id)) AS invalid,
        arraySort(groupArrayIf(member_id, length(arrayDistinct(arrayConcat([member_id], reached))) = length(member_ids))) AS roots
    FROM origin_reachability
    GROUP BY user_id, group_id
),
origin_selections AS (
    -- Kaya, Strong, Hang Ten, Apple Watch, and native Peloton bikes initiate by policy; copy edges remain evidence-only.
    SELECT
        *,
        multiIf(
            NOT invalid AND length(initiating_origins) = 1, toNullable(initiating_origins[1]),
            length(initiating_origins) > 1, NULL,
            length(group_member_ids) = 1 OR (NOT invalid AND length(roots) = 1), toNullable(roots[1]),
            NULL
        ) AS primary_activity_id
    FROM origin_decisions
),
activity_origins AS (
    SELECT
        decisions.user_id AS user_id,
        decisions.group_id AS group_id,
        decisions.primary_activity_id AS primary_activity_id,
        if(primary_activity_id IS NOT NULL, [assumeNotNull(primary_activity_id)], decisions.group_member_ids) AS origin_candidate_member_ids,
        arrayMap(edge -> map('upstreamMemberActivityId', toString(edge.1), 'downstreamMemberActivityId', toString(edge.2),
            'field', edge.3, 'value', edge.4), decisions.group_edges) AS origin_evidence,
        if(primary_activity_id IS NOT NULL, members.provider_id, NULL) AS primary_provider_id,
        if(primary_activity_id IS NOT NULL, members.source_name, NULL) AS primary_source_name
    FROM origin_selections AS decisions
    LEFT JOIN origin_members AS members
        ON members.user_id = decisions.user_id AND members.group_id = decisions.group_id
        AND members.activity_id = decisions.primary_activity_id
)
{% endmacro %}
