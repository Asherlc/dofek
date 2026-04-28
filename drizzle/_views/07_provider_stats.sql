-- Canonical definition of the fitness.provider_stats materialized view.
-- This precomputes per-provider record counts so sync.providerStats can do a
-- fast user-scoped lookup instead of scanning many tables on demand.

CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.provider_stats AS
WITH providers AS (
  SELECT DISTINCT user_id, provider_id
  FROM fitness.oauth_token
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.activity
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.daily_metrics
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.sleep_session
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.body_measurement
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.food_entry
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.health_event
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.metric_stream
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
  COALESCE(bm.cnt, 0)::bigint AS body_measurements,
  COALESCE(fe.cnt, 0)::bigint AS food_entries,
  COALESCE(he.cnt, 0)::bigint AS health_events,
  COALESCE(ms.cnt, 0)::bigint AS metric_stream,
  COALESCE(nd.cnt, 0)::bigint AS nutrition_daily,
  COALESCE(lp.cnt, 0)::bigint AS lab_panels,
  COALESCE(lr.cnt, 0)::bigint AS lab_results,
  COALESCE(je.cnt, 0)::bigint AS journal_entries
FROM providers p
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.activity
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
  FROM fitness.body_measurement
  GROUP BY user_id, provider_id
) bm ON bm.user_id = p.user_id AND bm.provider_id = p.provider_id
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
  FROM fitness.metric_stream
  GROUP BY user_id, provider_id
) ms ON ms.user_id = p.user_id AND ms.provider_id = p.provider_id
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

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS provider_stats_user_provider_idx
ON fitness.provider_stats (user_id, provider_id);
