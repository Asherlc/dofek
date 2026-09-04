-- Forward migration matching drizzle/_views/01_v_activity.sql at migration
-- creation time. The canonical file remains the source for later changes.

CREATE OR REPLACE VIEW fitness.v_activity AS
WITH RECURSIVE ranked AS (
  SELECT
    a.*,
    COALESCE(dp.priority, pp.priority, 100) AS prio
  FROM fitness.activity a
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = a.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = a.provider_id
      AND a.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
  WHERE a.provider_absent_at IS NULL
    AND a.deleted_at IS NULL
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
      NULLIF(trim(a.raw->>'sourceName'), ''),
      NULLIF(trim(a.source_name), '')
    ) AS subsource
  FROM fitness.activity a
  WHERE a.provider_absent_at IS NOT NULL
    AND a.deleted_at IS NULL
    AND a.external_id IS NOT NULL
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
  FROM tombstoned t
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
  FROM tombstoned t
  INNER JOIN fitness.activity a ON a.id = t.id
  WHERE t.provider_id = 'apple_health'
    AND NOT EXISTS (
      SELECT 1
      FROM fitness.activity sib
      WHERE sib.user_id = a.user_id
        AND sib.provider_id = 'apple_health'
        AND sib.deleted_at IS NULL
        AND sib.id <> a.id
        AND COALESCE(
          NULLIF(trim(sib.raw->'metadata'->>'HKMetadataKeySyncIdentifier'), ''),
          'time:' || sib.started_at::text || ':' || COALESCE(sib.ended_at::text, '') || ':' || COALESCE(
            NULLIF(trim(sib.raw->>'sourceName'), ''),
            NULLIF(trim(sib.source_name), ''),
            ''
          )
        ) = COALESCE(
          NULLIF(trim(a.raw->'metadata'->>'HKMetadataKeySyncIdentifier'), ''),
          'time:' || a.started_at::text || ':' || COALESCE(a.ended_at::text, '') || ':' || COALESCE(
            NULLIF(trim(a.raw->>'sourceName'), ''),
            NULLIF(trim(a.source_name), ''),
            ''
          )
        )
        AND (
          sib.provider_absent_at IS NULL AND sib.deleted_at IS NULL
          OR COALESCE(
            CASE
              WHEN (sib.raw->'metadata'->>'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (sib.raw->'metadata'->>'HKMetadataKeySyncVersion')::bigint
            END,
            0
          ) > COALESCE(
            CASE
              WHEN (a.raw->'metadata'->>'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (a.raw->'metadata'->>'HKMetadataKeySyncVersion')::bigint
            END,
            0
          )
          OR (
            COALESCE(
              CASE
                WHEN (sib.raw->'metadata'->>'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (sib.raw->'metadata'->>'HKMetadataKeySyncVersion')::bigint
              END,
              0
            ) = COALESCE(
              CASE
                WHEN (a.raw->'metadata'->>'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (a.raw->'metadata'->>'HKMetadataKeySyncVersion')::bigint
              END,
              0
            )
            AND sib.created_at > a.created_at
          )
        )
    )
),
clusterable AS (
  SELECT
    r.id,
    r.user_id,
    r.provider_id,
    r.canonical_type,
    r.started_at,
    COALESCE(r.ended_at, r.started_at + interval '1 hour') AS ended_at
  FROM ranked r
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.canonical_type,
    t.started_at,
    COALESCE(t.ended_at, t.started_at + interval '1 hour') AS ended_at
  FROM effective_tombstoned t
),
pair_metrics AS (
  SELECT
    c1.id AS id1,
    c2.id AS id2,
    c1.provider_id AS provider_id1,
    c2.provider_id AS provider_id2,
    c1.canonical_type AS canonical_type1,
    c2.canonical_type AS canonical_type2,
    EXTRACT(EPOCH FROM (
      LEAST(c1.ended_at, c2.ended_at) - GREATEST(c1.started_at, c2.started_at)
    )) AS overlap_seconds,
    EXTRACT(EPOCH FROM (
      GREATEST(c1.ended_at, c2.ended_at) - LEAST(c1.started_at, c2.started_at)
    )) AS union_seconds,
    LEAST(
      EXTRACT(EPOCH FROM (c1.ended_at - c1.started_at)),
      EXTRACT(EPOCH FROM (c2.ended_at - c2.started_at))
    ) AS shorter_duration_seconds
  FROM clusterable c1
  JOIN clusterable c2
    ON c1.user_id = c2.user_id
    AND c1.id < c2.id
    AND c1.started_at < c2.ended_at
    AND c1.ended_at > c2.started_at
),
pairs AS (
  SELECT id1, id2
  FROM pair_metrics
  WHERE overlap_seconds / NULLIF(union_seconds, 0) > 0.8
    OR (
      provider_id1 <> provider_id2
      AND canonical_type1 = canonical_type2
      AND overlap_seconds / NULLIF(shorter_duration_seconds, 0) > 0.8
    )
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(activity_id, group_id, depth) AS (
  SELECT id, id::text, 0 FROM clusterable
  UNION
  SELECT e.b, c.group_id, c.depth + 1
  FROM edges e
  JOIN clusters c ON c.activity_id = e.a
  WHERE c.depth < 2
),
final_groups AS (
  SELECT activity_id, MIN(group_id) AS group_id
  FROM clusters
  GROUP BY activity_id
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
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.activity_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
),
best_context_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.timezone,
    r.start_utc_offset_minutes,
    r.end_utc_offset_minutes,
    r.local_time_source
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.activity_id
  ORDER BY
    fg.group_id,
    CASE
      WHEN r.local_time_source = 'gps_timezone' THEN 1
      WHEN r.local_time_source IN (
        'provider_timezone',
        'device_timezone',
        'user_home_timezone'
      ) THEN 2
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
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.activity_id
  GROUP BY fg.group_id
),
absent_source_links AS (
  SELECT
    fg.group_id,
    jsonb_agg(
      jsonb_build_object(
        'providerId', t.provider_id,
        'externalId', t.external_id,
        'memberActivityId', t.id::text,
        'providerAbsentAt', t.provider_absent_at,
        'subsource', t.subsource
      )
      ORDER BY t.provider_id, t.id
    ) AS absent_source_external_ids
  FROM final_groups fg
  JOIN effective_tombstoned t ON t.id = fg.activity_id
  GROUP BY fg.group_id
),
tombstoned_groups AS (
  SELECT DISTINCT fg.group_id
  FROM final_groups fg
  JOIN effective_tombstoned t ON t.id = fg.activity_id
),
merged AS (
  SELECT
    b.canonical_id,
    b.provider_id,
    b.user_id,
    b.canonical_type,
    b.provider_type,
    b.modality,
    bounds.started_at,
    bounds.ended_at,
    b.source_name,
    (SELECT r.perceived_exertion
     FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.perceived_exertion IS NOT NULL
     ORDER BY r.prio ASC, r.id ASC LIMIT 1) AS perceived_exertion,
    (SELECT r.name FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.name IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS name,
    (SELECT r.notes FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.notes IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS notes,
    context.timezone,
    context.start_utc_offset_minutes,
    context.end_utc_offset_minutes,
    context.local_time_source,
    (SELECT jsonb_object_agg(sub.key, sub.value)
     FROM (
       SELECT raw_entry.key, raw_entry.value,
              ROW_NUMBER() OVER (PARTITION BY raw_entry.key ORDER BY r.prio ASC) AS rn
       FROM final_groups fg2
       JOIN ranked r ON r.id = fg2.activity_id,
       LATERAL jsonb_each(COALESCE(r.raw, '{}'::jsonb)) AS raw_entry (key, value)
       WHERE fg2.group_id = b.group_id
     ) sub WHERE sub.rn = 1
    ) AS raw,
    (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
     FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id) AS source_providers,
    (SELECT jsonb_agg(
       jsonb_build_object(
         'providerId', r.provider_id,
         'externalId', r.external_id,
         'memberActivityId', r.id::text,
         -- Preserve the per-member upstream app for grouped Apple Health rows.
         'subsource', COALESCE(
           NULLIF(trim(r.raw->>'sourceName'), ''),
           NULLIF(trim(r.source_name), '')
         )
       )
       ORDER BY r.provider_id
     )
     FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id
       AND r.external_id IS NOT NULL
       AND r.external_id <> ''
    ) AS source_external_ids,
    (SELECT array_agg(fg2.activity_id ORDER BY fg2.activity_id)
     FROM final_groups fg2
     WHERE fg2.group_id = b.group_id) AS member_activity_ids,
    absent_source_links.absent_source_external_ids
  FROM best_per_group b
  JOIN group_bounds bounds ON bounds.group_id = b.group_id
  JOIN best_context_per_group context ON context.group_id = b.group_id
  LEFT JOIN absent_source_links ON absent_source_links.group_id = b.group_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tombstoned_groups tg WHERE tg.group_id = b.group_id
  )
)
SELECT
  m.canonical_id AS id,
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
FROM merged m
ORDER BY m.started_at DESC;
