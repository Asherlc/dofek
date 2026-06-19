CREATE OR REPLACE VIEW fitness.v_activity AS
WITH RECURSIVE ranked AS (
  SELECT
    a.*,
    COALESCE(dp.priority, pp.priority, 100) AS prio
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
  WHERE a.provider_absent_at IS null
),

pairs AS (
  SELECT
    r1.id AS id1,
    r2.id AS id2
  FROM ranked AS r1
  INNER JOIN ranked AS r2
    ON
      r1.user_id = r2.user_id
      AND r1.id < r2.id
      AND EXTRACT(EPOCH FROM (
        LEAST(
          COALESCE(r1.ended_at, r1.started_at + interval '1 hour'),
          COALESCE(r2.ended_at, r2.started_at + interval '1 hour')
        )
        - GREATEST(r1.started_at, r2.started_at)
      )) / NULLIF(EXTRACT(EPOCH FROM (
        GREATEST(
          COALESCE(r1.ended_at, r1.started_at + interval '1 hour'),
          COALESCE(r2.ended_at, r2.started_at + interval '1 hour')
        )
        - LEAST(r1.started_at, r2.started_at)
      )), 0) > 0.8
),

edges AS (
  SELECT
    id1 AS a,
    id2 AS b
  FROM pairs
  UNION ALL
  SELECT
    id2 AS a,
    id1 AS b
  FROM pairs
),

clusters (activity_id, group_id, depth) AS (
  SELECT
    id,
    id::text,
    0
  FROM ranked
  UNION
  SELECT
    e.b,
    c.group_id,
    c.depth + 1
  FROM edges AS e
  INNER JOIN clusters AS c ON e.a = c.activity_id
  WHERE c.depth < 2
),

final_groups AS (
  SELECT
    activity_id,
    MIN(group_id) AS group_id
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
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  ORDER BY fg.group_id ASC, r.prio ASC, r.id ASC
),

group_bounds AS (
  SELECT
    fg.group_id,
    MIN(r.started_at) AS group_started_at,
    MAX(COALESCE(r.ended_at, r.started_at + interval '1 hour')) AS group_ended_at
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  GROUP BY fg.group_id
),

absent_candidates AS (
  SELECT
    id,
    provider_id,
    user_id,
    external_id,
    started_at,
    ended_at,
    provider_absent_at
  FROM fitness.activity
  WHERE
    provider_absent_at IS NOT null
    AND external_id IS NOT null
    AND external_id <> ''
),

absent_source_links AS (
  SELECT
    b.group_id,
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'providerId', absent.provider_id,
        'externalId', absent.external_id,
        'memberActivityId', absent.id,
        'providerAbsentAt', absent.provider_absent_at
      )
      ORDER BY absent.provider_id
    ) AS absent_source_external_ids
  FROM best_per_group AS b
  INNER JOIN group_bounds AS bounds ON b.group_id = bounds.group_id
  INNER JOIN absent_candidates AS absent ON b.user_id = absent.user_id
  WHERE
    NOT EXISTS (
      SELECT 1
      FROM final_groups AS fg_member
      WHERE
        fg_member.group_id = b.group_id
        AND fg_member.activity_id = absent.id
    )
    AND EXTRACT(EPOCH FROM (
      LEAST(
        COALESCE(absent.ended_at, absent.started_at + interval '1 hour'),
        bounds.group_ended_at
      )
      - GREATEST(absent.started_at, bounds.group_started_at)
    )) / NULLIF(EXTRACT(EPOCH FROM (
      GREATEST(
        COALESCE(absent.ended_at, absent.started_at + interval '1 hour'),
        bounds.group_ended_at
      )
      - LEAST(absent.started_at, bounds.group_started_at)
    )), 0) > 0.8
  GROUP BY b.group_id
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
    (
      SELECT r.timezone FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.timezone IS NOT null
      ORDER BY r.prio ASC LIMIT 1
    ) AS timezone,
    (
      SELECT JSONB_OBJECT_AGG(sub.raw_key, sub.raw_value)
      FROM (
        SELECT
          raw_entry.raw_key,
          raw_entry.raw_value,
          ROW_NUMBER() OVER (PARTITION BY raw_entry.raw_key ORDER BY r.prio ASC) AS raw_rank
        FROM final_groups AS fg2
        INNER JOIN ranked AS r ON fg2.activity_id = r.id
        CROSS JOIN LATERAL JSONB_EACH(COALESCE(r.raw, '{}'::jsonb)) AS raw_entry (raw_key, raw_value)
        WHERE fg2.group_id = b.group_id
      ) AS sub
      WHERE sub.raw_rank = 1
    ) AS raw,
    (
      SELECT ARRAY_AGG(DISTINCT r.provider_id ORDER BY r.provider_id)
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id
    ) AS source_providers,
    (
      SELECT
        JSONB_AGG(
          JSONB_BUILD_OBJECT('providerId', r.provider_id, 'externalId', r.external_id)
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
  LEFT JOIN absent_source_links ON b.group_id = absent_source_links.group_id
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
FROM merged AS m
ORDER BY m.started_at DESC;
