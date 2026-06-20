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
    a.external_id,
    a.started_at,
    a.ended_at,
    a.provider_absent_at
  FROM fitness.activity a
  WHERE a.provider_absent_at IS NOT NULL
    AND a.deleted_at IS NULL
    AND a.external_id IS NOT NULL
    AND a.external_id <> ''
),
clusterable AS (
  SELECT
    r.id,
    r.user_id,
    r.started_at,
    COALESCE(r.ended_at, r.started_at + interval '1 hour') AS ended_at
  FROM ranked r
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.started_at,
    COALESCE(t.ended_at, t.started_at + interval '1 hour') AS ended_at
  FROM tombstoned t
),
pairs AS (
  SELECT c1.id AS id1, c2.id AS id2
  FROM clusterable c1
  JOIN clusterable c2
    ON c1.user_id = c2.user_id
    AND c1.id < c2.id
    AND EXTRACT(EPOCH FROM (
      LEAST(c1.ended_at, c2.ended_at) - GREATEST(c1.started_at, c2.started_at)
    )) / NULLIF(EXTRACT(EPOCH FROM (
      GREATEST(c1.ended_at, c2.ended_at) - LEAST(c1.started_at, c2.started_at)
    )), 0) > 0.8
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
    r.activity_type,
    r.started_at,
    r.ended_at,
    r.source_name,
    r.prio
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.activity_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
),
absent_source_links AS (
  SELECT
    fg.group_id,
    jsonb_agg(
      jsonb_build_object(
        'providerId', t.provider_id,
        'externalId', t.external_id,
        'memberActivityId', t.id,
        'providerAbsentAt', t.provider_absent_at
      )
      ORDER BY t.provider_id
    ) AS absent_source_external_ids
  FROM final_groups fg
  JOIN tombstoned t ON t.id = fg.activity_id
  GROUP BY fg.group_id
),
merged AS (
  SELECT
    b.canonical_id,
    b.provider_id,
    b.user_id,
    b.activity_type,
    b.started_at,
    b.ended_at,
    b.source_name,
    (SELECT r.name FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.name IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS name,
    (SELECT r.notes FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.notes IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS notes,
    (SELECT r.timezone FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id AND r.timezone IS NOT NULL
     ORDER BY r.prio ASC LIMIT 1) AS timezone,
    (SELECT jsonb_object_agg(key, value)
     FROM (
       SELECT key, value, ROW_NUMBER() OVER (PARTITION BY key ORDER BY r.prio ASC) AS rn
       FROM final_groups fg2
       JOIN ranked r ON r.id = fg2.activity_id,
       LATERAL jsonb_each(COALESCE(r.raw, '{}'::jsonb))
       WHERE fg2.group_id = b.group_id
     ) sub WHERE rn = 1
    ) AS raw,
    (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
     FROM final_groups fg2 JOIN ranked r ON r.id = fg2.activity_id
     WHERE fg2.group_id = b.group_id) AS source_providers,
    (SELECT jsonb_agg(
       jsonb_build_object('providerId', r.provider_id, 'externalId', r.external_id)
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
  LEFT JOIN absent_source_links ON absent_source_links.group_id = b.group_id
)
SELECT
  m.canonical_id AS id,
  m.provider_id,
  m.user_id,
  m.canonical_id AS primary_activity_id,
  m.activity_type,
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
  m.absent_source_external_ids
FROM merged m
ORDER BY m.started_at DESC;
