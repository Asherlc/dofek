-- Canonical context replaces scalar storage; read projections remain computed.
ALTER TABLE fitness.climbing_entry
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
ALTER TABLE fitness.climbing_entry RENAME COLUMN location_name TO location_path;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN location_path TYPE jsonb
  USING fitness.convert_legacy_climbing_location(location_path, provider_id);
--> statement-breakpoint
DROP FUNCTION fitness.convert_legacy_climbing_location(text, text);
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN location_path SET DEFAULT '[]'::jsonb,
  ALTER COLUMN location_path SET NOT NULL;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry RENAME COLUMN wall_angle_degrees TO wall_angle;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN wall_angle TYPE jsonb
  USING CASE WHEN wall_angle IS NULL THEN NULL
    ELSE jsonb_build_object('value', wall_angle, 'unit', 'degrees') END;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry RENAME COLUMN lead TO climb_style;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN climb_style TYPE text USING
  CASE lower(btrim(CASE provider_id WHEN 'mountain-project' THEN raw->>'Style'
    WHEN 'openbeta' THEN raw->>'style' ELSE NULL END))
    WHEN 'lead' THEN 'lead' WHEN 'tr' THEN 'top-rope' WHEN 'follow' THEN 'follow'
    WHEN 'solo' THEN 'solo' WHEN 'aid' THEN 'aid'
    ELSE CASE WHEN climb_style THEN 'lead' WHEN NOT climb_style THEN 'top-rope' ELSE NULL END END;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry RENAME COLUMN sent TO result_style;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN result_style TYPE text USING
  COALESCE(NULLIF(btrim(CASE provider_id
    WHEN 'kaya' THEN raw#>>'{ascent_type,name}' WHEN 'kaya-export' THEN raw->>'ascentType'
    WHEN 'openbeta' THEN raw->>'attemptType'
    WHEN 'mountain-project' THEN CASE WHEN climb_type = 'boulder' THEN raw->>'Style' ELSE raw->>'Lead Style' END
    ELSE NULL END), ''), CASE WHEN result_style THEN 'Send' WHEN NOT result_style THEN 'Not sent' ELSE NULL END);
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry ALTER COLUMN attempt_count DROP DEFAULT,
  ALTER COLUMN attempt_count TYPE integer USING
    CASE WHEN provider_id IN ('mountain-project', 'openbeta')
      OR (provider_id = 'kaya-export' AND (raw->'attempts' IS NULL OR raw->'attempts' = 'null'::jsonb))
      THEN NULL ELSE attempt_count END,
  ADD COLUMN board jsonb;
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
  ADD CONSTRAINT climbing_entry_location_path_valid CHECK (fitness.climbing_location_path_valid(location_path)),
  ADD CONSTRAINT climbing_entry_board_valid CHECK (fitness.climbing_board_valid(board)),
  ADD CONSTRAINT climbing_entry_wall_angle_valid CHECK (fitness.climbing_wall_angle_valid(wall_angle)),
  ADD CONSTRAINT climbing_entry_climb_style_valid CHECK (climb_style IN ('lead', 'top-rope', 'follow', 'solo', 'aid')),
  ADD CONSTRAINT climbing_entry_result_style_nonempty CHECK (btrim(result_style) <> '');
--> statement-breakpoint
CREATE VIEW fitness.v_climbing_entry AS
SELECT entry.*,
  (SELECT string_agg(node->>'name', ' > ' ORDER BY position)
    FROM jsonb_array_elements(entry.location_path) WITH ORDINALITY AS nodes(node, position)) AS location_name,
  CASE entry.climb_style WHEN 'lead' THEN true WHEN 'top-rope' THEN false ELSE NULL END AS lead,
  CASE lower(btrim(entry.result_style))
    WHEN 'onsight' THEN true WHEN 'flash' THEN true WHEN 'redpoint' THEN true
    WHEN 'pinkpoint' THEN true WHEN 'repeat' THEN true WHEN 'send' THEN true
    WHEN 'attempt' THEN false WHEN 'not sent' THEN false WHEN 'fell/hung' THEN false ELSE NULL END AS sent,
  CASE WHEN entry.wall_angle->>'unit' = 'degrees'
    THEN (entry.wall_angle->>'value')::double precision ELSE NULL END AS wall_angle_degrees,
  CASE lower(btrim(entry.result_style))
    WHEN 'onsight' THEN 'Onsight' WHEN 'flash' THEN 'Flash' WHEN 'redpoint' THEN 'Redpoint'
    WHEN 'pinkpoint' THEN 'Pinkpoint' WHEN 'repeat' THEN 'Repeat' ELSE NULL END AS ascent_type
FROM fitness.climbing_entry entry;
