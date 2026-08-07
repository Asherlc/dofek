ALTER TABLE fitness.activity
ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

--> statement-breakpoint

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
  WHERE
    a.provider_absent_at IS null
    AND a.deleted_at IS null
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
    ) AS member_activity_ids
  FROM best_per_group AS b
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
  m.member_activity_ids
FROM merged AS m
ORDER BY m.started_at DESC;

--> statement-breakpoint
CREATE OR REPLACE VIEW fitness.provider_stats AS
WITH providers AS (
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.oauth_token
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.activity
  WHERE
    provider_absent_at IS null
    AND deleted_at IS null
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.daily_metrics
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.sleep_session
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.food_entry
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.health_event
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.v_nutrition_daily
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.lab_panel
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.lab_result
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.journal_entry
),

a AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.activity
  WHERE
    provider_absent_at IS null
    AND deleted_at IS null
  GROUP BY user_id, provider_id
),

dm AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.daily_metrics
  GROUP BY user_id, provider_id
),

ss AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.sleep_session
  GROUP BY user_id, provider_id
),

fe AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.food_entry
  WHERE confirmed = true
  GROUP BY user_id, provider_id
),

he AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.health_event
  GROUP BY user_id, provider_id
),

nd AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.v_nutrition_daily
  GROUP BY user_id, provider_id
),

lp AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.lab_panel
  GROUP BY user_id, provider_id
),

lr AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.lab_result
  GROUP BY user_id, provider_id
),

je AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.journal_entry
  GROUP BY user_id, provider_id
)

SELECT
  p.user_id,
  p.provider_id,
  COALESCE(a.cnt, 0)::bigint AS activities,
  COALESCE(dm.cnt, 0)::bigint AS daily_metrics,
  COALESCE(ss.cnt, 0)::bigint AS sleep_sessions,
  0::bigint AS body_measurements,
  COALESCE(fe.cnt, 0)::bigint AS food_entries,
  COALESCE(he.cnt, 0)::bigint AS health_events,
  0::bigint AS metric_stream,
  COALESCE(nd.cnt, 0)::bigint AS nutrition_daily,
  COALESCE(lp.cnt, 0)::bigint AS lab_panels,
  COALESCE(lr.cnt, 0)::bigint AS lab_results,
  COALESCE(je.cnt, 0)::bigint AS journal_entries
FROM providers AS p
LEFT JOIN a ON p.user_id = a.user_id AND p.provider_id = a.provider_id
LEFT JOIN dm ON p.user_id = dm.user_id AND p.provider_id = dm.provider_id
LEFT JOIN ss ON p.user_id = ss.user_id AND p.provider_id = ss.provider_id
LEFT JOIN fe ON p.user_id = fe.user_id AND p.provider_id = fe.provider_id
LEFT JOIN he ON p.user_id = he.user_id AND p.provider_id = he.provider_id
LEFT JOIN nd ON p.user_id = nd.user_id AND p.provider_id = nd.provider_id
LEFT JOIN lp ON p.user_id = lp.user_id AND p.provider_id = lp.provider_id
LEFT JOIN lr ON p.user_id = lr.user_id AND p.provider_id = lr.provider_id
LEFT JOIN je ON p.user_id = je.user_id AND p.provider_id = je.provider_id;
