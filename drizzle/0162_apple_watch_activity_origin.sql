-- Recording provenance and initiating-app assumptions; no metric priorities.
CREATE OR REPLACE FUNCTION fitness.resolve_activity_origin(input_members jsonb)
RETURNS TABLE (
  primary_activity_id uuid,
  primary_provider_id text,
  primary_source_name text,
  origin_candidate_member_ids uuid[],
  origin_evidence jsonb
)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH RECURSIVE labels AS (
  SELECT
    (member ->> 'id')::uuid AS member_id,
    member ->> 'providerId' AS provider_id,
    member ->> 'externalId' AS external_id,
    copy.provider_id AS copy_provider,
    copy.external_id AS copy_external_id,
    member ->> 'sourceName' AS source_name,
    LOWER(TRIM(COALESCE(member ->> 'sourceName', ''))) AS source_label,
    LOWER(TRIM(COALESCE(member -> 'raw' ->> 'sourceBundle', ''))) AS source_bundle,
    LOWER(TRIM(COALESCE(member -> 'raw' ->> 'device_name', ''))) AS raw_device_label
  FROM JSONB_ARRAY_ELEMENTS(input_members) AS member
  LEFT JOIN LATERAL fitness.activity_copy_identity(
    member ->> 'providerId', member ->> 'externalId', member -> 'raw'
  ) AS copy ON true
), hints AS (
  SELECT *,
    provider_id = 'apple_health'
      AND REPLACE(source_label, CHR(160), ' ') ~ '(^|[[:space:]])apple[[:space:]]+watch[[:space:]]*$'
      AS is_watch_recording,
    CASE
      WHEN provider_id = 'apple_health' THEN
        CASE source_label
          WHEN 'strava' THEN 'strava'
          WHEN 'garmin' THEN 'garmin'
          WHEN 'garmin connect' THEN 'garmin'
          WHEN 'wahoo' THEN 'wahoo'
          WHEN 'zwift' THEN 'zwift'
          WHEN 'peloton' THEN 'peloton'
          WHEN 'trainerroad' THEN 'trainerroad'
          WHEN 'whoop' THEN 'whoop'
          WHEN 'strong' THEN 'strong-csv'
          WHEN 'hang ten' THEN 'hang-ten'
          WHEN 'hang ten training' THEN 'hang-ten'
          ELSE NULL
        END
      WHEN provider_id = 'strava' AND source_label ~ '^garmin edge( |$)' THEN 'garmin'
      WHEN provider_id = 'strava' AND source_label ~ '^wahoo elemnt( |$)' THEN 'wahoo'
      ELSE NULL
    END AS label_provider,
    CASE WHEN provider_id = 'apple_health' AND source_bundle = 'com.strava.strava' THEN 'strava' END AS bundle_provider,
    CASE
      WHEN provider_id = 'strava' AND raw_device_label ~ '^garmin edge( |$)' THEN 'garmin'
      WHEN provider_id = 'strava' AND raw_device_label ~ '^wahoo elemnt( |$)' THEN 'wahoo'
    END AS device_provider
  FROM labels
), members AS (
  SELECT *,
    COALESCE(copy_provider, bundle_provider, label_provider, device_provider) AS upstream_provider,
    (SELECT COUNT(DISTINCT hint) > 1 FROM UNNEST(ARRAY[copy_provider, label_provider, bundle_provider, device_provider]) AS hint)
      OR (is_watch_recording AND bundle_provider IS NOT NULL)
      OR (provider_id = 'strava' AND source_label <> '' AND raw_device_label <> '' AND source_label <> raw_device_label) AS conflicting,
    CASE WHEN copy_provider IS NOT NULL THEN 'external_id'
      WHEN bundle_provider IS NOT NULL THEN 'raw.sourceBundle'
      WHEN label_provider IS NOT NULL THEN 'source_name' ELSE 'raw.device_name' END AS evidence_field,
    CASE WHEN copy_provider IS NOT NULL THEN copy_external_id
      WHEN bundle_provider IS NOT NULL THEN source_bundle
      WHEN label_provider IS NOT NULL THEN source_label ELSE raw_device_label END AS evidence_value
  FROM hints
), matches AS (
  SELECT upstream.member_id AS upstream_id, downstream.member_id AS downstream_id,
    downstream.evidence_field, downstream.evidence_value,
    COUNT(*) OVER (PARTITION BY downstream.member_id) AS match_count
  FROM members AS downstream
  INNER JOIN members AS upstream
    ON upstream.provider_id = downstream.upstream_provider AND upstream.member_id <> downstream.member_id
  WHERE NOT downstream.conflicting
    AND (downstream.copy_provider IS NULL
      OR LOWER(REPLACE(upstream.external_id, '-', '')) = downstream.copy_external_id)
    AND (downstream.provider_id <> 'strava' OR upstream.source_label = ''
      OR upstream.source_label = COALESCE(NULLIF(downstream.source_label, ''), downstream.raw_device_label))
), edges AS (
  SELECT upstream_id, downstream_id, evidence_field, evidence_value FROM matches WHERE match_count = 1
), reachability(upstream_id, downstream_id) AS (
  SELECT upstream_id, downstream_id FROM edges
  UNION
  SELECT reached.upstream_id, edge.downstream_id
  FROM reachability AS reached INNER JOIN edges AS edge ON reached.downstream_id = edge.upstream_id
), roots AS (
  SELECT member.member_id
  FROM members AS member
  WHERE NOT EXISTS (
    SELECT 1 FROM members AS other
    WHERE other.member_id <> member.member_id
      AND NOT EXISTS (SELECT 1 FROM reachability AS reached
        WHERE reached.upstream_id = member.member_id AND reached.downstream_id = other.member_id)
  )
), initiating_origins AS (
  -- Strong, Hang Ten, and Apple Watch initiate the workout by policy. Prefer a direct export over
  -- its Apple Health copy, without inventing transfer edges to other providers.
  SELECT member_id FROM members
  WHERE provider_id = 'strong-csv'
    OR is_watch_recording
    OR (provider_id = 'apple_health' AND source_label IN ('hang ten', 'hang ten training'))
    OR (provider_id = 'apple_health' AND source_label = 'strong'
      AND NOT EXISTS (SELECT 1 FROM members WHERE provider_id = 'strong-csv'))
), decision AS (
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM initiating_origins) = 1
      AND NOT EXISTS (SELECT 1 FROM members WHERE conflicting)
      AND NOT EXISTS (SELECT 1 FROM reachability WHERE upstream_id = downstream_id)
      THEN (SELECT member_id FROM initiating_origins)
    WHEN (SELECT COUNT(*) FROM initiating_origins) > 1 THEN NULL
    WHEN (SELECT COUNT(*) FROM members) = 1 OR (COUNT(*) = 1
    AND NOT EXISTS (SELECT 1 FROM members WHERE conflicting)
    AND NOT EXISTS (SELECT 1 FROM reachability WHERE upstream_id = downstream_id))
    THEN (ARRAY_AGG(member_id))[1] ELSE NULL END AS selected_id
  FROM roots
)
SELECT
  decision.selected_id,
  selected.provider_id,
  selected.source_name,
  CASE WHEN decision.selected_id IS NOT NULL THEN ARRAY[decision.selected_id]
    ELSE COALESCE((SELECT ARRAY_AGG(member_id ORDER BY member_id) FROM members), ARRAY[]::uuid[]) END,
  COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
    'upstreamMemberActivityId', upstream_id, 'downstreamMemberActivityId', downstream_id,
    'field', evidence_field, 'value', evidence_value) ORDER BY upstream_id, downstream_id, evidence_field, evidence_value)
    FROM edges), '[]'::jsonb)
FROM decision LEFT JOIN members AS selected ON selected.member_id = decision.selected_id;
$$;
