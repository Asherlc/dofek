-- Canonical definition of the fitness.v_activity view.
-- This file is the source definition for fresh databases, local test schemas,
-- and future forward migrations that need to update the deployed view.
--
-- To change v_activity: edit THIS file and add a forward migration when the
-- deployed view definition must change.
-- Git merge conflicts here force developers to reconcile concurrent changes.

CREATE OR REPLACE VIEW fitness.v_activity AS
WITH ranked AS (
  SELECT
    a.*,
    COALESCE(dp.priority, pp.priority, 100) AS prio,
    payload.complete_working_set_count,
    payload.set_count,
    payload.exercise_count
  FROM fitness.activity AS a
  LEFT JOIN fitness.provider_priority AS pp ON a.provider_id = pp.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.priority
    FROM fitness.device_priority AS dp2
    WHERE
      dp2.provider_id = a.provider_id
      AND a.source_name LIKE dp2.source_name_pattern
    ORDER BY LENGTH(dp2.source_name_pattern) DESC
    LIMIT 1
  ) AS dp ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE s.set_type = 'working'
        AND (
          s.weight_kg IS NOT null OR s.reps IS NOT null
          OR s.duration_seconds IS NOT null OR s.distance_meters IS NOT null
        )
      ) AS complete_working_set_count,
      COUNT(*) AS set_count,
      COUNT(DISTINCT s.exercise_id) AS exercise_count
    FROM fitness.strength_set AS s
    WHERE s.activity_id = a.id
  ) AS payload ON true
  WHERE
    a.provider_absent_at IS null
    AND a.deleted_at IS null
),

tombstoned AS (
  SELECT
    a.id,
    a.user_id,
    a.provider_id,
    a.canonical_type,
    a.external_id,
    a.started_at,
    a.ended_at,
    a.provider_absent_at,
    COALESCE(
      NULLIF(TRIM(a.raw ->> 'sourceName'), ''),
      NULLIF(TRIM(a.source_name), '')
    ) AS subsource
  FROM fitness.activity AS a
  WHERE
    a.provider_absent_at IS NOT null
    AND a.deleted_at IS null
    AND a.external_id IS NOT null
    AND a.external_id <> ''
),

effective_tombstoned AS (
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.canonical_type,
    t.external_id,
    t.started_at,
    t.ended_at,
    t.provider_absent_at,
    t.subsource
  FROM tombstoned AS t
  WHERE t.provider_id <> 'apple_health'
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.canonical_type,
    t.external_id,
    t.started_at,
    t.ended_at,
    t.provider_absent_at,
    t.subsource
  FROM tombstoned AS t
  INNER JOIN fitness.activity AS a ON t.id = a.id
  WHERE
    t.provider_id = 'apple_health'
    AND NOT EXISTS (
      SELECT 1
      FROM fitness.activity AS sib
      WHERE
        sib.user_id = a.user_id
        AND sib.provider_id = 'apple_health'
        AND sib.deleted_at IS null
        AND sib.id <> a.id
        AND COALESCE(
          NULLIF(TRIM(sib.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || sib.started_at::text || ':' || COALESCE(sib.ended_at::text, '') || ':' || COALESCE(
            NULLIF(TRIM(sib.raw ->> 'sourceName'), ''),
            NULLIF(TRIM(sib.source_name), ''),
            ''
          )
        ) = COALESCE(
          NULLIF(TRIM(a.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || a.started_at::text || ':' || COALESCE(a.ended_at::text, '') || ':' || COALESCE(
            NULLIF(TRIM(a.raw ->> 'sourceName'), ''),
            NULLIF(TRIM(a.source_name), ''),
            ''
          )
        )
        AND (
          sib.provider_absent_at IS null AND sib.deleted_at IS null
          OR COALESCE(
            CASE
              WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
            END,
            0
          ) > COALESCE(
            CASE
              WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
            END,
            0
          )
          OR (
            COALESCE(
              CASE
                WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
              END,
              0
            ) = COALESCE(
              CASE
                WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
              END,
              0
            )
            AND sib.created_at > a.created_at
          )
        )
    )
),

final_groups AS (
  SELECT
    r.id AS activity_id,
    r.group_id
  FROM ranked AS r
  UNION ALL
  SELECT
    t.id AS activity_id,
    a.group_id
  FROM effective_tombstoned AS t
  INNER JOIN fitness.activity AS a ON t.id = a.id
),

best_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.id AS canonical_id,
    r.provider_id,
    r.user_id,
    r.canonical_type,
    r.provider_type,
    r.modality,
    r.started_at,
    r.ended_at,
    r.source_name,
    r.prio
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  ORDER BY
    fg.group_id ASC,
    r.complete_working_set_count DESC,
    r.set_count DESC,
    r.exercise_count DESC,
    (r.canonical_type NOT IN ('cardio', 'other')) DESC,
    COALESCE(
      NULLIF(LOWER(TRIM(r.provider_type)), '') <> LOWER(r.canonical_type::text),
      false
    ) DESC,
    r.prio ASC,
    r.id ASC
),

best_context_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.timezone,
    r.start_utc_offset_minutes,
    r.end_utc_offset_minutes,
    r.local_time_source
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  ORDER BY
    fg.group_id ASC,
    CASE
      WHEN r.local_time_source = 'gps_timezone' THEN 1
      WHEN r.local_time_source IN (
        'provider_timezone',
        'device_timezone',
        'user_home_timezone'
      ) THEN 2
      -- Direct source evidence outranks a configured home-zone fallback for travel.
      WHEN r.local_time_source IN ('provider_offset', 'device_offset') THEN 3
      WHEN r.local_time_source = 'home_zone_fallback' THEN 4
      WHEN r.local_time_source = 'unknown' THEN 5
      ELSE 6
    END ASC,
    r.prio ASC,
    r.id ASC
),

group_bounds AS (
  SELECT
    fg.group_id,
    MIN(r.started_at) AS started_at,
    MAX(r.ended_at) AS ended_at
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  GROUP BY fg.group_id
),

absent_source_links AS (
  SELECT
    fg.group_id,
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'providerId', t.provider_id,
        'externalId', t.external_id,
        'memberActivityId', t.id::text,
        'providerAbsentAt', t.provider_absent_at,
        'subsource', t.subsource
      )
      ORDER BY t.provider_id, t.id
    ) AS absent_source_external_ids
  FROM final_groups AS fg
  INNER JOIN effective_tombstoned AS t ON fg.activity_id = t.id
  GROUP BY fg.group_id
),

tombstoned_groups AS (
  SELECT DISTINCT fg.group_id
  FROM final_groups AS fg
  INNER JOIN effective_tombstoned AS t ON fg.activity_id = t.id
),

merged AS (
  SELECT
    b.group_id,
    b.canonical_id,
    b.provider_id,
    b.user_id,
    b.canonical_type,
    b.provider_type,
    b.modality,
    bounds.started_at,
    bounds.ended_at,
    b.source_name,
    (
      SELECT r.perceived_exertion
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.perceived_exertion IS NOT null
      ORDER BY r.prio ASC, r.id ASC LIMIT 1
    ) AS perceived_exertion,
    (
      SELECT r.name FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.name IS NOT null
      ORDER BY r.prio ASC LIMIT 1
    ) AS name,
    (
      SELECT r.notes FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.notes IS NOT null
      ORDER BY r.prio ASC LIMIT 1
    ) AS notes,
    CASE
      WHEN context.local_time_source = 'unknown' THEN null
      ELSE context.timezone
    END AS timezone,
    context.start_utc_offset_minutes,
    context.end_utc_offset_minutes,
    context.local_time_source,
    (
      SELECT JSONB_OBJECT_AGG(sub.key, sub.value)
      FROM (
        SELECT
          raw_entry.key,
          raw_entry.value,
          ROW_NUMBER() OVER (PARTITION BY raw_entry.key ORDER BY r.prio ASC) AS rn
        FROM final_groups AS fg2
        INNER JOIN ranked AS r ON fg2.activity_id = r.id,
          LATERAL JSONB_EACH(COALESCE(r.raw, '{}'::jsonb)) AS raw_entry (key, value)
        WHERE fg2.group_id = b.group_id
      ) AS sub
      WHERE sub.rn = 1
    ) AS raw,
    (
      SELECT ARRAY_AGG(DISTINCT r.provider_id ORDER BY r.provider_id)
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id
    ) AS source_providers,
    (
      SELECT
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'providerId', r.provider_id,
            'externalId', r.external_id,
            'memberActivityId', r.id::text,
            -- Preserve the per-member upstream app for grouped Apple Health rows.
            'subsource', COALESCE(
              NULLIF(TRIM(r.raw ->> 'sourceName'), ''),
              NULLIF(TRIM(r.source_name), '')
            )
          )
          ORDER BY r.provider_id
        )
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE
        fg2.group_id = b.group_id
        AND r.external_id IS NOT null
        AND r.external_id <> ''
    ) AS source_external_ids,
    (
      SELECT ARRAY_AGG(fg2.activity_id ORDER BY fg2.activity_id)
      FROM final_groups AS fg2
      WHERE fg2.group_id = b.group_id
    ) AS member_activity_ids,
    absent_source_links.absent_source_external_ids
  FROM best_per_group AS b
  INNER JOIN group_bounds AS bounds ON b.group_id = bounds.group_id
  INNER JOIN best_context_per_group AS context ON b.group_id = context.group_id
  LEFT JOIN absent_source_links ON b.group_id = absent_source_links.group_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tombstoned_groups AS tg
    WHERE tg.group_id = b.group_id
  )
)

SELECT
  m.group_id AS id,
  m.provider_id,
  m.user_id,
  m.canonical_id AS primary_activity_id,
  m.canonical_type,
  m.provider_type,
  m.modality,
  m.started_at,
  m.ended_at,
  m.source_name,
  m.name,
  m.notes,
  m.timezone,
  m.raw,
  m.source_providers,
  m.source_external_ids,
  m.member_activity_ids,
  m.absent_source_external_ids,
  m.start_utc_offset_minutes,
  m.end_utc_offset_minutes,
  COALESCE(m.local_time_source, 'unknown') AS local_time_source,
  m.perceived_exertion
FROM merged AS m
ORDER BY m.started_at DESC;
