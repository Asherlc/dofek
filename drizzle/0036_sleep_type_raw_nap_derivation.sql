-- ============================================================
-- Migration 0036: Store raw sleep classification as sleep_type
-- ============================================================
-- `is_nap` is derivable and should not be stored on the raw table.
-- Keep `is_nap` as a computed field in v_sleep.

ALTER TABLE fitness.sleep_session
  ADD COLUMN IF NOT EXISTS sleep_type TEXT;

--> statement-breakpoint

-- Backfill existing rows to preserve behavior after dropping is_nap.
UPDATE fitness.sleep_session
SET sleep_type = CASE
  WHEN is_nap = true THEN 'nap'
  ELSE 'sleep'
END
WHERE sleep_type IS NULL;

--> statement-breakpoint

DROP MATERIALIZED VIEW IF EXISTS fitness.v_sleep;

--> statement-breakpoint

ALTER TABLE fitness.sleep_session
  DROP COLUMN IF EXISTS is_nap;

--> statement-breakpoint

CREATE MATERIALIZED VIEW fitness.v_sleep AS
WITH RECURSIVE ranked AS (
  SELECT
    s.*,
    COALESCE(dp.sleep_priority, pp.sleep_priority, dp.priority, pp.priority, 100) AS prio,
    CASE
      -- Provider-native explicit nap labels.
      WHEN s.sleep_type IN ('nap', 'late_nap', 'rest') THEN true
      -- Provider-native explicit main sleep labels.
      WHEN s.sleep_type IN ('sleep', 'long_sleep', 'main') THEN false
      -- Fitbit's non-main sleep is often nap-like; use duration as tie-breaker.
      WHEN s.sleep_type = 'not_main' THEN COALESCE(s.duration_minutes < 120, true)
      -- No provider label available (Apple Health / HealthKit / Eight Sleep): fallback heuristic.
      WHEN s.duration_minutes IS NOT NULL THEN s.duration_minutes < 120
      ELSE false
    END AS is_nap
  FROM fitness.sleep_session s
  LEFT JOIN fitness.provider_priority pp ON pp.provider_id = s.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.sleep_priority, dp2.priority
    FROM fitness.device_priority dp2
    WHERE dp2.provider_id = s.provider_id
      AND s.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) dp ON true
),
pairs AS (
  SELECT r1.id AS id1, r2.id AS id2
  FROM ranked r1
  JOIN ranked r2
    ON r1.id < r2.id
    AND r1.user_id = r2.user_id
    AND r1.is_nap = r2.is_nap
    AND EXTRACT(EPOCH FROM (
      LEAST(COALESCE(r1.ended_at, r1.started_at + interval '8 hours'),
            COALESCE(r2.ended_at, r2.started_at + interval '8 hours'))
      - GREATEST(r1.started_at, r2.started_at)
    )) / NULLIF(EXTRACT(EPOCH FROM (
      GREATEST(COALESCE(r1.ended_at, r1.started_at + interval '8 hours'),
               COALESCE(r2.ended_at, r2.started_at + interval '8 hours'))
      - LEAST(r1.started_at, r2.started_at)
    )), 0) > 0.8
),
edges AS (
  SELECT id1 AS a, id2 AS b FROM pairs
  UNION ALL
  SELECT id2 AS a, id1 AS b FROM pairs
),
clusters(sleep_id, group_id) AS (
  SELECT id, id::text FROM ranked
  UNION
  SELECT e.b, c.group_id
  FROM edges e
  JOIN clusters c ON c.sleep_id = e.a
),
final_groups AS (
  SELECT sleep_id, MIN(group_id) AS group_id FROM clusters GROUP BY sleep_id
),
best AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.*
  FROM final_groups fg
  JOIN ranked r ON r.id = fg.sleep_id
  ORDER BY fg.group_id, r.prio ASC, r.id ASC
)
SELECT
  b.id,
  b.provider_id,
  b.user_id,
  b.started_at,
  b.ended_at,
  b.duration_minutes,
  b.deep_minutes,
  b.rem_minutes,
  b.light_minutes,
  b.awake_minutes,
  b.efficiency_pct,
  b.sleep_type,
  b.is_nap,
  b.source_name,
  (SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
   FROM final_groups fg JOIN ranked r ON r.id = fg.sleep_id
   WHERE fg.group_id = b.group_id) AS source_providers
FROM best b
ORDER BY b.started_at DESC;

CREATE UNIQUE INDEX v_sleep_id_idx ON fitness.v_sleep (id);
CREATE INDEX v_sleep_time_idx ON fitness.v_sleep (started_at DESC);
CREATE INDEX IF NOT EXISTS v_sleep_user_nap_time_idx
  ON fitness.v_sleep (user_id, is_nap, started_at DESC);
