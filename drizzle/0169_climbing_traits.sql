-- dofek: deployment-mode=maintenance
-- Replace the scalar in place; existing recorded grips and missing metadata are preserved.
-- https://www.postgresql.org/docs/current/sql-altertable.html
ALTER TYPE fitness.climbing_hold_type ADD VALUE 'volume';
--> statement-breakpoint
ALTER TYPE fitness.climbing_hold_type ADD VALUE 'jam';
--> statement-breakpoint
ALTER TYPE fitness.climbing_hold_type ADD VALUE 'no_grips';
--> statement-breakpoint
DROP VIEW fitness.v_climbing_log_entry;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
ALTER COLUMN hold_type TYPE fitness.climbing_hold_type[]
USING CASE WHEN hold_type IS NULL THEN NULL ELSE ARRAY[hold_type] END;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry RENAME COLUMN hold_type TO hold_types;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry ADD CONSTRAINT climbing_log_entry_hold_types_valid
CHECK (hold_types IS NULL OR (CARDINALITY(hold_types) > 0 AND ARRAY_NDIMS(hold_types) = 1 AND ARRAY_POSITION(hold_types, NULL) IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.climbing_wall_angle_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL THEN true
    WHEN jsonb_typeof(value) = 'object' AND value ? 'category'
      AND value - 'category' = '{}'::jsonb
    THEN COALESCE(value->>'category' IN ('slab', 'vertical', 'overhang', 'roof'), false)
    WHEN jsonb_typeof(value) = 'object' AND value ?& ARRAY['value', 'unit']
      AND value - ARRAY['value', 'unit'] = '{}'::jsonb AND jsonb_typeof(value->'value') = 'number'
    THEN abs((value->>'value')::numeric) <= 1.7976931348623157e308
      AND (value->'unit' = 'null'::jsonb OR
        (value->'unit' = '"degrees"'::jsonb AND (value->>'value')::numeric BETWEEN -90 AND 90))
    ELSE false END;
$$;
--> statement-breakpoint
-- Catalogue outdoor defaults apply only on reads; explicit source settings win.
-- Raw catalogue and log records retain their original missing values.
CREATE VIEW fitness.v_climbing_log_entry AS
SELECT
  entry.id,
  entry.user_id,
  entry.provider_id,
  entry.external_id,
  entry.climb_id,
  entry.activity_id,
  entry.climbed_on,
  entry.discipline,
  entry.title,
  entry.notes,
  entry.board,
  entry.wall_angle,
  entry.hold_types,
  entry.source_name,
  entry.raw,
  entry.provider_absent_at,
  entry.created_at,
  climb.name AS climb_name,
  climb.kind AS climb_kind,
  COALESCE(climb.setting, CASE
    WHEN
      entry.provider_id IN ('mountain-project', 'openbeta')
      AND climb.kind IN ('boulder', 'route')
      THEN 'outdoor'::fitness.climb_setting
  END) AS setting,
  climb.route_protection,
  climb.coordinates,
  COALESCE((
    SELECT JSONB_AGG(JSONB_BUILD_OBJECT('value', component.value, 'system', component.system) ORDER BY component.position)
    FROM fitness.climb_grade AS component
    WHERE component.climb_id = climb.id
  ), '[]'::jsonb) AS published_grades,
  COALESCE((
    SELECT JSONB_AGG(JSONB_BUILD_OBJECT('value', component.value, 'system', component.system) ORDER BY component.position)
    FROM fitness.climbing_log_entry_grade AS component
    WHERE component.climbing_log_entry_id = entry.id
  ), '[]'::jsonb) AS reported_grades,
  COALESCE((
    WITH RECURSIVE chain AS (
      SELECT
        area.id,
        area.user_id,
        area.provider_id,
        area.name,
        area.external_id,
        area.parent_area_id,
        area.coordinates,
        0 AS depth,
        ARRAY[area.id] AS visited
      FROM fitness.area AS area
      WHERE area.id = climb.area_id
      UNION ALL
      SELECT
        parent.id,
        parent.user_id,
        parent.provider_id,
        parent.name,
        parent.external_id,
        parent.parent_area_id,
        parent.coordinates,
        child.depth + 1 AS depth,
        child.visited || parent.id AS visited
      FROM fitness.area AS parent INNER JOIN chain AS child ON parent.id = child.parent_area_id
      WHERE NOT parent.id = ANY(child.visited)
    )

    SELECT
      JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'id', chain.id, 'userId', chain.user_id, 'providerId', chain.provider_id,
          'name', chain.name, 'externalId', chain.external_id, 'parentAreaId', chain.parent_area_id,
          'coordinates', CASE
            WHEN chain.coordinates IS NOT NULL
              THEN JSONB_BUILD_OBJECT('latitude', chain.coordinates[1], 'longitude', chain.coordinates[0])
          END
        )
        ORDER BY chain.depth DESC
      ) AS area_path
    FROM chain
  ), '[]'::jsonb) AS area_path,
  attempts.recorded_climb_attempt_count,
  attempts.recorded_pitch_attempt_count,
  attempts.recorded_climb_outcome,
  CASE
    WHEN entry.discipline = 'rock_climbing' AND climb.kind IN ('boulder', 'route')
      THEN attempts.free_send
  END AS free_send
FROM fitness.climbing_log_entry AS entry
LEFT JOIN fitness.climb AS climb ON entry.climb_id = climb.id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE attempt.scope = 'climb') AS recorded_climb_attempt_count,
    COUNT(*) FILTER (WHERE attempt.scope = 'pitch') AS recorded_pitch_attempt_count,
    CASE
      WHEN BOOL_OR(attempt.outcome = 'completed') FILTER (WHERE attempt.scope = 'climb') THEN 'completed'
      WHEN
        COUNT(*) FILTER (WHERE attempt.scope = 'climb') > 0
        AND BOOL_AND(COALESCE(attempt.outcome = 'failed', FALSE)) FILTER (WHERE attempt.scope = 'climb') THEN 'failed'
    END AS recorded_climb_outcome,
    CASE
      WHEN BOOL_OR(
        attempt.outcome = 'completed' AND attempt.fell_or_hung = FALSE AND attempt.used_aid = FALSE
        AND (climb.kind = 'route' OR (climb.kind = 'boulder' AND attempt.dabbed = FALSE))
      ) FILTER (WHERE attempt.scope = 'climb') THEN TRUE
      WHEN COUNT(*) FILTER (WHERE attempt.scope = 'climb') > 0 AND BOOL_AND(COALESCE(
        attempt.outcome = 'failed' OR attempt.fell_or_hung = TRUE OR attempt.used_aid = TRUE
        OR (climb.kind = 'boulder' AND attempt.dabbed = TRUE), FALSE
      )) FILTER (WHERE attempt.scope = 'climb') THEN FALSE
    END AS free_send
  FROM fitness.v_climbing_attempt AS attempt
  WHERE attempt.climbing_log_entry_id = entry.id
) AS attempts ON TRUE;
