-- Replace the expensive materialized Postgres view with a plain view.
-- Behavior is preserved while removing refresh cost and concurrent materialized-view locks.

DROP TABLE IF EXISTS pg_temp.dofek_migration_view_definitions;

CREATE TEMP TABLE pg_temp.dofek_migration_view_definitions (
  view_name text PRIMARY KEY,
  relation_kind "char" NOT NULL,
  view_definition text NOT NULL
);

DO $$
DECLARE
  dependent_kind "char";
  dependent_definition text;
BEGIN
  SELECT view_class.relkind, pg_get_viewdef(view_class.oid, true)
  INTO dependent_kind, dependent_definition
  FROM pg_class AS view_class
  JOIN pg_namespace AS view_namespace ON view_namespace.oid = view_class.relnamespace
  WHERE view_namespace.nspname = 'fitness'
    AND view_class.relname = 'activity_summary'
    AND view_class.relkind IN ('m', 'v');

  IF dependent_definition IS NOT NULL THEN
    INSERT INTO pg_temp.dofek_migration_view_definitions (
      view_name,
      relation_kind,
      view_definition
    )
    VALUES ('fitness.activity_summary', dependent_kind, dependent_definition);

    IF dependent_kind = 'm' THEN
      EXECUTE 'DROP MATERIALIZED VIEW fitness.activity_summary';
    ELSE
      EXECUTE 'DROP VIEW fitness.activity_summary';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS pg_temp.dofek_migration_view_definitions;

DROP MATERIALIZED VIEW IF EXISTS fitness.deduped_sensor;
DROP INDEX IF EXISTS fitness.deduped_sensor_pk;
DROP INDEX IF EXISTS fitness.deduped_sensor_activity_time_idx;

CREATE VIEW fitness.deduped_sensor AS

-- Step 0: Flatten v_activity to get canonical_id -> member_id mapping
WITH canonical_activities AS (
  SELECT
    a.id AS canonical_id,
    a.user_id,
    a.started_at,
    a.ended_at,
    a.member_activity_ids
  FROM fitness.v_activity a
),
activity_members AS (
  SELECT a.id AS canonical_id, a.user_id, unnest(a.member_activity_ids) AS member_id
  FROM fitness.v_activity a
),

-- Step 1: For activity-linked samples, pick the best provider per (canonical_activity, channel)
linked_best_source AS (
  SELECT DISTINCT ON (canonical_id, channel)
    canonical_id, channel, provider_id
  FROM (
    SELECT am.canonical_id, ms.channel, ms.provider_id, COUNT(*) AS sample_count
    FROM fitness.metric_stream ms
    JOIN activity_members am ON ms.activity_id = am.member_id
    WHERE ms.activity_id IS NOT NULL
    GROUP BY am.canonical_id, ms.channel, ms.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
),

-- Step 2: Compute fallback end bound per canonical activity.
-- For open-ended activities (ended_at IS NULL), fallback is capped at the last
-- linked sample timestamp to avoid an unbounded ambient window.
linked_sample_bounds AS (
  SELECT am.canonical_id, MAX(ms.recorded_at) AS last_linked_sample_at
  FROM fitness.metric_stream ms
  JOIN activity_members am ON ms.activity_id = am.member_id
  WHERE ms.activity_id IS NOT NULL
  GROUP BY am.canonical_id
),
fallback_windows AS (
  SELECT
    ca.canonical_id,
    ca.user_id,
    ca.started_at,
    COALESCE(ca.ended_at, lsb.last_linked_sample_at) AS fallback_ended_at
  FROM canonical_activities ca
  LEFT JOIN linked_sample_bounds lsb ON lsb.canonical_id = ca.canonical_id
),

-- Step 3: For ambient samples (activity_id IS NULL), only consider channels that
-- have zero activity-linked samples for the canonical activity.
ambient_best_source AS (
  SELECT DISTINCT ON (canonical_id, channel)
    canonical_id, channel, provider_id
  FROM (
    SELECT fw.canonical_id, ms.channel, ms.provider_id, COUNT(*) AS sample_count
    FROM fitness.metric_stream ms
    JOIN fallback_windows fw
      ON fw.user_id = ms.user_id
    LEFT JOIN linked_best_source lbs
      ON lbs.canonical_id = fw.canonical_id
      AND lbs.channel = ms.channel
    WHERE ms.activity_id IS NULL
      AND fw.fallback_ended_at IS NOT NULL
      AND ms.recorded_at >= fw.started_at
      AND ms.recorded_at <= fw.fallback_ended_at
      AND lbs.canonical_id IS NULL
    GROUP BY fw.canonical_id, ms.channel, ms.provider_id
  ) counts
  ORDER BY canonical_id, channel, sample_count DESC
),

-- Step 4: Linked samples from the winning provider per channel.
linked_samples AS (
  SELECT
    am.canonical_id AS activity_id,
    am.user_id,
    ms.recorded_at,
    ms.channel,
    MAX(ms.scalar) AS scalar
  FROM fitness.metric_stream ms
  JOIN activity_members am ON ms.activity_id = am.member_id
  JOIN linked_best_source lbs
    ON am.canonical_id = lbs.canonical_id
    AND ms.channel = lbs.channel
    AND ms.provider_id = lbs.provider_id
  WHERE ms.activity_id IS NOT NULL
    AND ms.scalar IS NOT NULL
  GROUP BY am.canonical_id, am.user_id, ms.recorded_at, ms.channel
),

-- Step 5: Ambient fallback samples from the winning ambient provider per channel.
ambient_samples AS (
  SELECT
    fw.canonical_id AS activity_id,
    fw.user_id,
    ms.recorded_at,
    ms.channel,
    MAX(ms.scalar) AS scalar
  FROM fitness.metric_stream ms
  JOIN fallback_windows fw
    ON fw.user_id = ms.user_id
  JOIN ambient_best_source abs
    ON fw.canonical_id = abs.canonical_id
    AND ms.channel = abs.channel
    AND ms.provider_id = abs.provider_id
  WHERE ms.activity_id IS NULL
    AND fw.fallback_ended_at IS NOT NULL
    AND ms.recorded_at >= fw.started_at
    AND ms.recorded_at <= fw.fallback_ended_at
    AND ms.scalar IS NOT NULL
  GROUP BY fw.canonical_id, fw.user_id, ms.recorded_at, ms.channel
)

-- Step 6: Union linked samples with ambient fallback samples.
SELECT
  ls.activity_id,
  ls.user_id,
  ls.recorded_at,
  ls.channel,
  ls.scalar
FROM linked_samples ls
UNION ALL
SELECT
  asmp.activity_id,
  asmp.user_id,
  asmp.recorded_at,
  asmp.channel,
  asmp.scalar
FROM ambient_samples asmp;

DO $$
DECLARE
  dependent_kind "char";
  dependent_definition text;
BEGIN
  SELECT relation_kind, view_definition
  INTO dependent_kind, dependent_definition
  FROM pg_temp.dofek_migration_view_definitions
  WHERE view_name = 'fitness.activity_summary';

  IF dependent_definition IS NOT NULL THEN
    IF dependent_kind = 'm' THEN
      EXECUTE format('CREATE MATERIALIZED VIEW fitness.activity_summary AS %s', dependent_definition);
    ELSE
      EXECUTE format('CREATE VIEW fitness.activity_summary AS %s', dependent_definition);
    END IF;
  END IF;
END
$$;
