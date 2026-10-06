-- Canonical context replaces scalar storage; read projections remain computed.
ALTER TABLE fitness.climbing_entry
DROP CONSTRAINT IF EXISTS climbing_entry_aggregate_pair,
DROP CONSTRAINT IF EXISTS climbing_entry_location_name_nonempty,
DROP CONSTRAINT IF EXISTS climbing_entry_wall_angle_range,
DROP CONSTRAINT IF EXISTS climbing_entry_lead_routes_only;
--> statement-breakpoint
CREATE FUNCTION fitness.convert_legacy_climbing_location(label text, source text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', btrim(node), 'externalId', NULL, 'kind', NULL)
    ORDER BY position), '[]'::jsonb)
  FROM unnest(CASE WHEN source = 'mountain-project' THEN string_to_array(label, ' > ')
    ELSE ARRAY[label] END) WITH ORDINALITY AS nodes(node, position)
  WHERE NULLIF(btrim(node), '') IS NOT NULL;
$$;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_entry RENAME COLUMN location_name TO location_path;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore changing-column-type
ALTER TABLE fitness.climbing_entry ALTER COLUMN location_path TYPE jsonb
USING fitness.convert_legacy_climbing_location(location_path, provider_id);
--> statement-breakpoint
DROP FUNCTION fitness.convert_legacy_climbing_location(text, text);
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN location_path SET DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore adding-not-nullable-field
ALTER TABLE fitness.climbing_entry ALTER COLUMN location_path SET NOT NULL;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_entry RENAME COLUMN wall_angle_degrees TO wall_angle;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore changing-column-type
ALTER TABLE fitness.climbing_entry ALTER COLUMN wall_angle TYPE jsonb
USING CASE
  WHEN wall_angle IS NULL THEN NULL
  ELSE jsonb_build_object('value', wall_angle, 'unit', 'degrees')
END;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_entry RENAME COLUMN lead TO climb_style;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore changing-column-type
ALTER TABLE fitness.climbing_entry ALTER COLUMN climb_style TYPE text USING
CASE lower(btrim(CASE provider_id
  WHEN 'mountain-project' THEN raw ->> 'Style'
  WHEN 'openbeta' THEN raw ->> 'style'
END))
  WHEN 'lead' THEN 'lead' WHEN 'tr' THEN 'top-rope' WHEN 'follow' THEN 'follow'
  WHEN 'solo' THEN 'solo' WHEN 'aid' THEN 'aid'
  ELSE CASE WHEN climb_style THEN 'lead' WHEN NOT climb_style THEN 'top-rope' END
END;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_entry RENAME COLUMN sent TO result_style;
--> statement-breakpoint
-- Maintenance-only conversion: quiesce old readers/writers per docs/climbing-context.md.
-- PostgreSQL lock/rewrite semantics: https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore changing-column-type
ALTER TABLE fitness.climbing_entry ALTER COLUMN result_style TYPE text USING
coalesce(nullif(btrim(CASE provider_id
  WHEN 'kaya' THEN raw #>> '{ascent_type,name}' WHEN 'kaya-export' THEN raw ->> 'ascentType'
  WHEN 'openbeta' THEN raw ->> 'attemptType'
  WHEN 'mountain-project' THEN CASE WHEN climb_type = 'boulder' THEN raw ->> 'Style' ELSE raw ->> 'Lead Style' END
END), ''), CASE WHEN result_style THEN 'Send' WHEN NOT result_style THEN 'Not sent' END);
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN attempt_count DROP DEFAULT,
ADD COLUMN board jsonb;
--> statement-breakpoint
UPDATE fitness.climbing_entry SET attempt_count = NULL
WHERE attempt_count IS NOT NULL AND (
  provider_id IN ('mountain-project', 'openbeta')
  OR (provider_id = 'kaya-export' AND (raw -> 'attempts' IS NULL OR raw -> 'attempts' = 'null'::jsonb))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.climbing_location_path_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) node
    WHERE CASE WHEN jsonb_typeof(node) <> 'object' THEN true ELSE
      NOT (node ?& ARRAY['name', 'externalId', 'kind'])
      OR node - ARRAY['name', 'externalId', 'kind'] <> '{}'::jsonb
      OR jsonb_typeof(node->'name') <> 'string' OR btrim(node->>'name') = ''
      OR NOT (node->'externalId' = 'null'::jsonb OR
        (jsonb_typeof(node->'externalId') = 'string' AND btrim(node->>'externalId') <> ''))
      OR NOT (node->'kind' = 'null'::jsonb OR node->'kind' IN
        ('"destination"'::jsonb, '"area"'::jsonb, '"subarea"'::jsonb, '"gym"'::jsonb)) END
  ) ELSE false END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.climbing_board_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL THEN true WHEN jsonb_typeof(value) <> 'object' THEN false ELSE
    COALESCE(value ?& ARRAY['name', 'externalId'] AND value - ARRAY['name', 'externalId'] = '{}'::jsonb
    AND jsonb_typeof(value->'name') = 'string' AND btrim(value->>'name') <> ''
    AND (value->'externalId' = 'null'::jsonb OR
      (jsonb_typeof(value->'externalId') = 'string' AND btrim(value->>'externalId') <> '')), false) END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.climbing_wall_angle_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL THEN true
    WHEN jsonb_typeof(value) = 'object' AND value ?& ARRAY['value', 'unit']
      AND value - ARRAY['value', 'unit'] = '{}'::jsonb AND jsonb_typeof(value->'value') = 'number'
    THEN abs((value->>'value')::numeric) <= 1.7976931348623157e308
      AND (value->'unit' = 'null'::jsonb OR
        (value->'unit' = '"degrees"'::jsonb AND (value->>'value')::numeric BETWEEN -90 AND 90))
    ELSE false END;
$$;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_location_path_valid CHECK (fitness.climbing_location_path_valid(location_path)) NOT VALID,
ADD CONSTRAINT climbing_entry_board_valid CHECK (fitness.climbing_board_valid(board)) NOT VALID,
ADD CONSTRAINT climbing_entry_wall_angle_valid CHECK (fitness.climbing_wall_angle_valid(wall_angle)) NOT VALID,
ADD CONSTRAINT climbing_entry_climb_style_valid CHECK (climb_style IN ('lead', 'top-rope', 'follow', 'solo', 'aid')) NOT VALID,
ADD CONSTRAINT climbing_entry_result_style_nonempty CHECK (btrim(result_style) <> '') NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_location_path_valid,
VALIDATE CONSTRAINT climbing_entry_board_valid,
VALIDATE CONSTRAINT climbing_entry_wall_angle_valid,
VALIDATE CONSTRAINT climbing_entry_climb_style_valid,
VALIDATE CONSTRAINT climbing_entry_result_style_nonempty;
--> statement-breakpoint
CREATE VIEW fitness.v_climbing_entry AS
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
      THEN (entry.wall_angle ->> 'value')::double precision
  END AS wall_angle_degrees,
  CASE lower(btrim(entry.result_style))
    WHEN 'onsight' THEN 'Onsight' WHEN 'flash' THEN 'Flash' WHEN 'redpoint' THEN 'Redpoint'
    WHEN 'pinkpoint' THEN 'Pinkpoint' WHEN 'repeat' THEN 'Repeat'
  END AS ascent_type
FROM fitness.climbing_entry AS entry;
