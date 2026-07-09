CREATE TYPE fitness.climbing_climb_type AS ENUM ('boulder', 'route');

CREATE TYPE fitness.climbing_grade_system AS ENUM ('v_scale', 'yds');

CREATE TABLE IF NOT EXISTS fitness.climbing_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES fitness.activity (id) ON DELETE CASCADE,
  external_id text,
  climb_type fitness.climbing_climb_type NOT NULL,
  grade_system fitness.climbing_grade_system NOT NULL,
  grade text NOT NULL,
  sent boolean NOT NULL,
  route_name text,
  location_name text,
  source_name text,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT climbing_entry_grade_nonempty CHECK (btrim(grade) <> ''),
  CONSTRAINT climbing_entry_external_id_nonempty CHECK (external_id IS NULL OR btrim(external_id) <> ''),
  CONSTRAINT climbing_entry_route_name_nonempty CHECK (route_name IS NULL OR btrim(route_name) <> ''),
  CONSTRAINT climbing_entry_location_name_nonempty CHECK (location_name IS NULL OR btrim(location_name) <> ''),
  CONSTRAINT climbing_entry_source_name_nonempty CHECK (source_name IS NULL OR btrim(source_name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS climbing_entry_activity_external_id_idx
ON fitness.climbing_entry (activity_id, external_id)
WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS climbing_entry_activity_idx -- noqa: PG01
ON fitness.climbing_entry (activity_id);

CREATE INDEX IF NOT EXISTS climbing_entry_grade_lookup_idx -- noqa: PG01
ON fitness.climbing_entry (climb_type, grade_system, grade);
