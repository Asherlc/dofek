ALTER TABLE fitness.climbing_log_entry ADD COLUMN area_id uuid;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry ADD CONSTRAINT climbing_log_entry_area_owner_provider_fk
FOREIGN KEY (user_id, provider_id, area_id) REFERENCES fitness.area (user_id, provider_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry VALIDATE CONSTRAINT climbing_log_entry_area_owner_provider_fk;
--> statement-breakpoint
CREATE INDEX climbing_log_entry_area_idx ON fitness.climbing_log_entry (area_id);
--> statement-breakpoint
CREATE OR REPLACE VIEW fitness.v_climbing_log_entry AS
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
  COALESCE(paths.area_path, '[]'::jsonb) AS area_path,
  attempts.recorded_climb_attempt_count,
  attempts.recorded_pitch_attempt_count,
  attempts.recorded_climb_outcome,
  CASE
    WHEN entry.discipline = 'rock_climbing' AND climb.kind IN ('boulder', 'route')
      THEN attempts.free_send
  END AS free_send,
  entry.area_id AS log_area_id,
  COALESCE(paths.climb_area_path, '[]'::jsonb) AS climb_area_path
FROM fitness.climbing_log_entry AS entry
LEFT JOIN fitness.climb AS climb ON entry.climb_id = climb.id

LEFT JOIN LATERAL (
  WITH RECURSIVE chain AS (
    SELECT
      area.*,
      area.id AS root_id,
      0 AS depth,
      ARRAY[area.id] AS visited
    FROM fitness.area AS area
    WHERE area.id IN (entry.area_id, climb.area_id)
    UNION ALL
    SELECT
      parent.*,
      child.root_id,
      child.depth + 1 AS depth,
      child.visited || parent.id AS visited
    FROM fitness.area AS parent INNER JOIN chain AS child ON parent.id = child.parent_area_id
    WHERE NOT parent.id = ANY(child.visited)
  ),

  nodes AS (
    SELECT
      chain.root_id,
      chain.depth,
      JSONB_BUILD_OBJECT(
        'id', chain.id, 'userId', chain.user_id, 'providerId', chain.provider_id,
        'name', chain.name, 'externalId', chain.external_id, 'parentAreaId', chain.parent_area_id,
        'coordinates', CASE
          WHEN chain.coordinates IS NOT NULL
            THEN JSONB_BUILD_OBJECT('latitude', chain.coordinates[1], 'longitude', chain.coordinates[0])
        END
      ) AS node
    FROM chain
  )

  SELECT
    JSONB_AGG(nodes.node ORDER BY nodes.depth DESC) FILTER (
      WHERE nodes.root_id = COALESCE(entry.area_id, climb.area_id)
    ) AS area_path,
    JSONB_AGG(nodes.node ORDER BY nodes.depth DESC) FILTER (WHERE nodes.root_id = climb.area_id) AS climb_area_path
  FROM nodes
) AS paths ON TRUE
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
