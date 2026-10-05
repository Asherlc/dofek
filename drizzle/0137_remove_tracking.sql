DROP VIEW fitness.provider_stats;
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
  WHERE provider_absent_at IS NULL AND deleted_at IS NULL
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
  FROM fitness.v_nutrition_provider_daily
  UNION
  SELECT DISTINCT
    user_id,
    provider_id
  FROM fitness.clinical_record
),

a AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.activity
  WHERE
    provider_absent_at IS NULL
    AND deleted_at IS NULL
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
  WHERE confirmed = TRUE
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
  FROM fitness.v_nutrition_provider_daily
  GROUP BY user_id, provider_id
),

cr AS (
  SELECT
    user_id,
    provider_id,
    COUNT(*) AS cnt
  FROM fitness.clinical_record
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
  COALESCE(cr.cnt, 0)::bigint AS clinical_records
FROM providers AS p
LEFT JOIN a ON p.user_id = a.user_id AND p.provider_id = a.provider_id
LEFT JOIN dm ON p.user_id = dm.user_id AND p.provider_id = dm.provider_id
LEFT JOIN ss ON p.user_id = ss.user_id AND p.provider_id = ss.provider_id
LEFT JOIN fe ON p.user_id = fe.user_id AND p.provider_id = fe.provider_id
LEFT JOIN he ON p.user_id = he.user_id AND p.provider_id = he.provider_id
LEFT JOIN nd ON p.user_id = nd.user_id AND p.provider_id = nd.provider_id
LEFT JOIN cr ON p.user_id = cr.user_id AND p.provider_id = cr.provider_id;
DROP TABLE fitness.journal_entry;
--> statement-breakpoint
DROP TABLE fitness.journal_question;
--> statement-breakpoint
DROP TABLE fitness.life_events;
--> statement-breakpoint
DROP TABLE fitness.subjective_symptom;
--> statement-breakpoint
DROP TABLE fitness.subjective_check_in;
--> statement-breakpoint
DROP TABLE fitness.injury_event;
--> statement-breakpoint
DROP TABLE fitness.body_region;
