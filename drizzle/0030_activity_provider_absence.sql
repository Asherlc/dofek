ALTER TABLE fitness.activity
ADD COLUMN IF NOT EXISTS provider_absent_at timestamp with time zone;

--> statement-breakpoint

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
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.user_id = r2.user_id
    AND r1.id < r2.id
    AND EXTRACT(EPOCH FROM (
      LEAST(COALESCE(r1.ended_at, r1.started_at + interval '1 hour'),
            COALESCE(r2.ended_at, r2.started_at + interval '1 hour'))
      - GREATEST(r1.started_at, r2.started_at)
    )) / NULLIF(EXTRACT(EPOCH FROM (
      GREATEST(COALESCE(r1.ended_at, r1.started_at + interval '1 hour'),
               COALESCE(r2.ended_at, r2.started_at + interval '1 hour'))
      - LEAST(r1.started_at, r2.started_at)
    )), 0) > 0.8
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(activity_id, group_id) AS (
  SELECT id, id::text FROM ranked
  UNION
  SELECT e.b, c.group_id
  FROM edges e
  JOIN clusters c ON c.activity_id = e.a
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
     WHERE fg2.group_id = b.group_id) AS member_activity_ids
  FROM best_per_group b
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
FROM merged m
ORDER BY m.started_at DESC;

--> statement-breakpoint
CREATE OR REPLACE VIEW fitness.provider_stats AS
WITH providers AS (
  SELECT DISTINCT user_id, provider_id
  FROM fitness.oauth_token
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.activity WHERE provider_absent_at IS NULL
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.daily_metrics
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.sleep_session
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.food_entry
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.health_event
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.v_nutrition_daily
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.lab_panel
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.lab_result
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.journal_entry
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
FROM providers p
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.activity
  WHERE provider_absent_at IS NULL
  GROUP BY user_id, provider_id
) a ON a.user_id = p.user_id AND a.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.daily_metrics
  GROUP BY user_id, provider_id
) dm ON dm.user_id = p.user_id AND dm.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.sleep_session
  GROUP BY user_id, provider_id
) ss ON ss.user_id = p.user_id AND ss.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.food_entry
  WHERE confirmed = true
  GROUP BY user_id, provider_id
) fe ON fe.user_id = p.user_id AND fe.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.health_event
  GROUP BY user_id, provider_id
) he ON he.user_id = p.user_id AND he.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.v_nutrition_daily
  GROUP BY user_id, provider_id
) nd ON nd.user_id = p.user_id AND nd.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.lab_panel
  GROUP BY user_id, provider_id
) lp ON lp.user_id = p.user_id AND lp.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.lab_result
  GROUP BY user_id, provider_id
) lr ON lr.user_id = p.user_id AND lr.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.journal_entry
  GROUP BY user_id, provider_id
) je ON je.user_id = p.user_id AND je.provider_id = p.provider_id;
