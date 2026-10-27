ALTER TABLE fitness.climbing_entry
ADD COLUMN route_protection TEXT[],
ADD CONSTRAINT climbing_entry_route_protection_valid
CHECK (route_protection <@ ARRAY['sport', 'trad']::TEXT[] AND array_position(route_protection, NULL) IS NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_route_protection_valid;
--> statement-breakpoint
CREATE OR REPLACE VIEW fitness.v_climbing_entry AS
SELECT
  entry.id,
  entry.user_id,
  entry.provider_id,
  entry.activity_id,
  entry.unattached_date,
  entry.provider_absent_at,
  entry.external_id,
  entry.climb_type,
  entry.grade_system,
  entry.grade,
  entry.result_style,
  entry.attempt_count,
  entry.climb_style,
  entry.wall_angle,
  entry.board,
  entry.hold_type,
  entry.route_name,
  entry.location_path,
  entry.source_name,
  entry.raw,
  entry.created_at,
  (
    SELECT string_agg(nodes.node ->> 'name', ' > ' ORDER BY nodes.position)
    FROM jsonb_array_elements(entry.location_path) WITH ORDINALITY AS nodes (node, position)
  ) AS location_name,
  CASE entry.climb_style WHEN 'lead' THEN TRUE WHEN 'top-rope' THEN FALSE END AS lead,
  CASE lower(btrim(entry.result_style))
    WHEN 'onsight' THEN TRUE WHEN 'flash' THEN TRUE WHEN 'redpoint' THEN TRUE
    WHEN 'pinkpoint' THEN TRUE WHEN 'repeat' THEN TRUE WHEN 'send' THEN TRUE
    WHEN 'attempt' THEN FALSE WHEN 'not sent' THEN FALSE WHEN 'fell/hung' THEN FALSE
  END AS sent,
  CASE
    WHEN entry.wall_angle ->> 'unit' = 'degrees'
      THEN (entry.wall_angle ->> 'value')::DOUBLE PRECISION
  END AS wall_angle_degrees,
  CASE lower(btrim(entry.result_style))
    WHEN 'onsight' THEN 'Onsight' WHEN 'flash' THEN 'Flash' WHEN 'redpoint' THEN 'Redpoint'
    WHEN 'pinkpoint' THEN 'Pinkpoint' WHEN 'repeat' THEN 'Repeat'
  END AS ascent_type,
  entry.route_protection
FROM fitness.climbing_entry AS entry;
