CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.activity_training_summary (
  activity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  activity_type text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_minutes double precision,
  avg_hr real,
  max_hr smallint,
  min_hr smallint,
  avg_power real,
  max_power smallint,
  avg_cadence real,
  avg_speed real,
  total_distance real,
  elevation_gain_m real,
  elevation_loss_m real,
  hr_sample_count integer NOT NULL DEFAULT 0,
  power_sample_count integer NOT NULL DEFAULT 0,
  total_sample_count integer NOT NULL DEFAULT 0,
  normalized_power real,
  hr_bpm_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  power_watt_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_training_summary_user_started_idx
  ON analytics.activity_training_summary (user_id, started_at DESC);

CREATE INDEX activity_training_summary_user_type_started_idx
  ON analytics.activity_training_summary (user_id, activity_type, started_at DESC);

CREATE TABLE analytics.activity_rollup_dirty (
  activity_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  reason text NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_rollup_dirty_marked_idx
  ON analytics.activity_rollup_dirty (marked_at ASC);

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.refresh_activity_training_summary(target_activity_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM fitness.v_activity
    WHERE id = target_activity_id
  ) THEN
    DELETE FROM analytics.activity_training_summary
    WHERE activity_id = target_activity_id;
    DELETE FROM analytics.activity_rollup_dirty
    WHERE activity_id = target_activity_id;
    RETURN;
  END IF;

  WITH activity_row AS (
    SELECT
      va.id AS activity_id,
      va.user_id,
      va.activity_type,
      va.started_at,
      va.ended_at,
      asum.avg_hr,
      asum.max_hr,
      asum.min_hr,
      asum.avg_power,
      asum.max_power,
      asum.avg_cadence,
      asum.avg_speed,
      asum.total_distance,
      asum.elevation_gain_m,
      asum.elevation_loss_m,
      asum.hr_sample_count,
      asum.power_sample_count,
      asum.sample_count AS total_sample_count
    FROM fitness.v_activity va
    LEFT JOIN fitness.activity_summary asum ON asum.activity_id = va.id
    WHERE va.id = target_activity_id
  ),
  power_rolling AS (
    SELECT
      ds.activity_id,
      AVG(ds.scalar) OVER (
        PARTITION BY ds.activity_id
        ORDER BY ds.recorded_at
        RANGE BETWEEN INTERVAL '29 seconds' PRECEDING AND CURRENT ROW
      ) AS rolling_30s_power
    FROM fitness.deduped_sensor ds
    WHERE ds.activity_id = target_activity_id
      AND ds.channel = 'power'
      AND ds.scalar > 0
  ),
  normalized_power AS (
    SELECT
      activity_id,
      CASE
        WHEN COUNT(*) >= 60
          THEN ROUND(POWER(AVG(POWER(rolling_30s_power, 4)), 0.25)::numeric, 1)::real
        ELSE NULL::real
      END AS normalized_power
    FROM power_rolling
    GROUP BY activity_id
  ),
  hr_histogram AS (
    SELECT
      activity_id,
      COALESCE(jsonb_object_agg(bpm::text, sample_count ORDER BY bpm), '{}'::jsonb) AS hr_bpm_counts
    FROM (
      SELECT
        activity_id,
        ROUND(scalar)::int AS bpm,
        COUNT(*)::int AS sample_count
      FROM fitness.deduped_sensor
      WHERE activity_id = target_activity_id
        AND channel = 'heart_rate'
        AND scalar IS NOT NULL
        AND scalar > 0
      GROUP BY activity_id, ROUND(scalar)::int
    ) counts
    GROUP BY activity_id
  ),
  power_histogram AS (
    SELECT
      activity_id,
      COALESCE(jsonb_object_agg(watts::text, sample_count ORDER BY watts), '{}'::jsonb) AS power_watt_counts
    FROM (
      SELECT
        activity_id,
        ROUND(scalar)::int AS watts,
        COUNT(*)::int AS sample_count
      FROM fitness.deduped_sensor
      WHERE activity_id = target_activity_id
        AND channel = 'power'
        AND scalar IS NOT NULL
        AND scalar > 0
      GROUP BY activity_id, ROUND(scalar)::int
    ) counts
    GROUP BY activity_id
  )
  INSERT INTO analytics.activity_training_summary (
    activity_id,
    user_id,
    activity_type,
    started_at,
    ended_at,
    duration_minutes,
    avg_hr,
    max_hr,
    min_hr,
    avg_power,
    max_power,
    avg_cadence,
    avg_speed,
    total_distance,
    elevation_gain_m,
    elevation_loss_m,
    hr_sample_count,
    power_sample_count,
    total_sample_count,
    normalized_power,
    hr_bpm_counts,
    power_watt_counts,
    computed_at
  )
  SELECT
    ar.activity_id,
    ar.user_id,
    ar.activity_type,
    ar.started_at,
    ar.ended_at,
    EXTRACT(EPOCH FROM (ar.ended_at - ar.started_at)) / 60.0 AS duration_minutes,
    ar.avg_hr,
    ar.max_hr,
    ar.min_hr,
    ar.avg_power,
    ar.max_power,
    ar.avg_cadence,
    ar.avg_speed,
    ar.total_distance,
    ar.elevation_gain_m,
    ar.elevation_loss_m,
    COALESCE(ar.hr_sample_count, 0),
    COALESCE(ar.power_sample_count, 0),
    COALESCE(ar.total_sample_count, 0),
    np.normalized_power,
    COALESCE(hr.hr_bpm_counts, '{}'::jsonb),
    COALESCE(pwr.power_watt_counts, '{}'::jsonb),
    now()
  FROM activity_row ar
  LEFT JOIN normalized_power np ON np.activity_id = ar.activity_id
  LEFT JOIN hr_histogram hr ON hr.activity_id = ar.activity_id
  LEFT JOIN power_histogram pwr ON pwr.activity_id = ar.activity_id
  ON CONFLICT (activity_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    activity_type = EXCLUDED.activity_type,
    started_at = EXCLUDED.started_at,
    ended_at = EXCLUDED.ended_at,
    duration_minutes = EXCLUDED.duration_minutes,
    avg_hr = EXCLUDED.avg_hr,
    max_hr = EXCLUDED.max_hr,
    min_hr = EXCLUDED.min_hr,
    avg_power = EXCLUDED.avg_power,
    max_power = EXCLUDED.max_power,
    avg_cadence = EXCLUDED.avg_cadence,
    avg_speed = EXCLUDED.avg_speed,
    total_distance = EXCLUDED.total_distance,
    elevation_gain_m = EXCLUDED.elevation_gain_m,
    elevation_loss_m = EXCLUDED.elevation_loss_m,
    hr_sample_count = EXCLUDED.hr_sample_count,
    power_sample_count = EXCLUDED.power_sample_count,
    total_sample_count = EXCLUDED.total_sample_count,
    normalized_power = EXCLUDED.normalized_power,
    hr_bpm_counts = EXCLUDED.hr_bpm_counts,
    power_watt_counts = EXCLUDED.power_watt_counts,
    computed_at = EXCLUDED.computed_at;
END;
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.refresh_dirty_activity_training_summaries(batch_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  refreshed_count integer := 0;
  dirty_record record;
BEGIN
  FOR dirty_record IN
    SELECT activity_id
    FROM analytics.activity_rollup_dirty
    ORDER BY marked_at ASC
    LIMIT batch_limit
  LOOP
    PERFORM analytics.refresh_activity_training_summary(dirty_record.activity_id);
    DELETE FROM analytics.activity_rollup_dirty
    WHERE activity_id = dirty_record.activity_id;
    refreshed_count := refreshed_count + 1;
  END LOOP;

  RETURN refreshed_count;
END;
$$;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT activity_id, user_id, 'metric_stream_changed', now()
  FROM new_rows
  WHERE activity_id IS NOT NULL
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER metric_stream_activity_rollup_dirty_insert
AFTER INSERT ON fitness.metric_stream
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_insert();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT activity_id, user_id, 'metric_stream_changed', now()
  FROM old_rows
  WHERE activity_id IS NOT NULL
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER metric_stream_activity_rollup_dirty_delete
AFTER DELETE ON fitness.metric_stream
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_delete();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT activity_id, user_id, 'metric_stream_changed', now()
  FROM (
    SELECT activity_id, user_id FROM old_rows WHERE activity_id IS NOT NULL
    UNION
    SELECT activity_id, user_id FROM new_rows WHERE activity_id IS NOT NULL
  ) changed
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER metric_stream_activity_rollup_dirty_update
AFTER UPDATE ON fitness.metric_stream
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_metric_stream_update();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.mark_activity_rollup_dirty_from_activity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT DISTINCT id, user_id, 'activity_changed', now()
  FROM (
    SELECT id, user_id FROM old_rows
    UNION
    SELECT id, user_id FROM new_rows
  ) changed
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at;

  RETURN NULL;
END;
$$;

CREATE TRIGGER activity_rollup_dirty_update
AFTER UPDATE ON fitness.activity
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.mark_activity_rollup_dirty_from_activity_update();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION analytics.delete_activity_training_summary_from_activity_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM analytics.activity_training_summary summary
  USING old_rows
  WHERE summary.activity_id = old_rows.id;

  DELETE FROM analytics.activity_rollup_dirty dirty
  USING old_rows
  WHERE dirty.activity_id = old_rows.id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER activity_training_summary_delete
AFTER DELETE ON fitness.activity
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.delete_activity_training_summary_from_activity_delete();
