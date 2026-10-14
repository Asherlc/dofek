-- Preparation for a quiesced, bounded climbing-log conversion. No row backfill here.
-- The operational cutover must complete before 0147 can remove legacy storage.
CREATE TYPE fitness.climb_kind AS ENUM ('boulder', 'route', 'summit');
--> statement-breakpoint
CREATE TYPE fitness.climb_setting AS ENUM ('indoor', 'outdoor');
--> statement-breakpoint
CREATE TYPE fitness.climbing_discipline AS ENUM (
  'rock_climbing', 'ice_climbing', 'mixed_climbing', 'snow_climbing',
  'hiking', 'scrambling', 'mountaineering'
);
--> statement-breakpoint
CREATE TYPE fitness.rope_method AS ENUM ('lead', 'top_rope', 'follow', 'unroped');
--> statement-breakpoint
CREATE TYPE fitness.protection_style AS ENUM ('sport', 'trad');
--> statement-breakpoint
CREATE TYPE fitness.attempt_scope AS ENUM ('climb', 'pitch');
--> statement-breakpoint
CREATE TYPE fitness.grade_system AS ENUM (
  'v_scale', 'font', 'yds', 'french', 'uiaa', 'ewbank', 'saxon', 'norwegian',
  'brazilian_crux', 'british_adjectival', 'british_technical', 'aid', 'water_ice',
  'alpine_ice', 'mixed', 'ifas', 'nccs'
);
--> statement-breakpoint
CREATE TABLE fitness.area (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  provider_id text NOT NULL REFERENCES fitness.provider (id),
  external_id text,
  name text NOT NULL,
  parent_area_id uuid,
  -- PostgreSQL point uses x = longitude, y = latitude; zero is a valid coordinate.
  -- https://www.postgresql.org/docs/current/datatype-geometric.html
  coordinates point,
  CONSTRAINT area_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT area_external_id_nonempty CHECK (external_id IS NULL OR btrim(external_id) <> ''),
  CONSTRAINT area_parent_distinct CHECK (parent_area_id <> id),
  CONSTRAINT area_coordinates_valid CHECK (
    coordinates[0] BETWEEN -180 AND 180 AND coordinates[1] BETWEEN -90 AND 90
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX area_owner_provider_id_idx ON fitness.area (user_id, provider_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX area_source_external_id_idx ON fitness.area (user_id, provider_id, external_id)
WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX area_parent_idx ON fitness.area (parent_area_id);
--> statement-breakpoint
ALTER TABLE fitness.area ADD CONSTRAINT area_parent_owner_provider_fk
FOREIGN KEY (user_id, provider_id, parent_area_id) REFERENCES fitness.area (user_id, provider_id, id) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.area VALIDATE CONSTRAINT area_parent_owner_provider_fk;
--> statement-breakpoint
CREATE TABLE fitness.climb (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  provider_id text NOT NULL REFERENCES fitness.provider (id),
  external_id text,
  name text,
  kind fitness.climb_kind,
  area_id uuid,
  setting fitness.climb_setting,
  route_protection fitness.protection_style[],
  coordinates point,
  CONSTRAINT climb_name_nonempty CHECK (name IS NULL OR btrim(name) <> ''),
  CONSTRAINT climb_external_id_nonempty CHECK (external_id IS NULL OR btrim(external_id) <> ''),
  CONSTRAINT climb_route_protection_valid CHECK (array_position(route_protection, NULL) IS NULL),
  CONSTRAINT climb_coordinates_valid CHECK (
    coordinates[0] BETWEEN -180 AND 180 AND coordinates[1] BETWEEN -90 AND 90
  ),
  CONSTRAINT climb_area_owner_provider_fk FOREIGN KEY (user_id, provider_id, area_id)
  REFERENCES fitness.area (user_id, provider_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX climb_owner_provider_id_idx ON fitness.climb (user_id, provider_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX climb_source_external_id_idx ON fitness.climb (user_id, provider_id, external_id)
WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX climb_area_idx ON fitness.climb (area_id);
--> statement-breakpoint
CREATE TABLE fitness.pitch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  climb_id uuid NOT NULL REFERENCES fitness.climb (id) ON DELETE CASCADE,
  external_id text,
  number bigint,
  name text,
  CONSTRAINT pitch_number_positive CHECK (number > 0),
  CONSTRAINT pitch_external_id_nonempty CHECK (external_id IS NULL OR btrim(external_id) <> ''),
  CONSTRAINT pitch_name_nonempty CHECK (name IS NULL OR btrim(name) <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX pitch_source_external_id_idx ON fitness.pitch (climb_id, external_id)
WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX pitch_number_idx ON fitness.pitch (climb_id, number) WHERE number IS NOT NULL;
--> statement-breakpoint
CREATE INDEX pitch_climb_idx ON fitness.pitch (climb_id);
--> statement-breakpoint
CREATE TABLE fitness.climb_grade (
  climb_id uuid NOT NULL REFERENCES fitness.climb (id) ON DELETE CASCADE,
  value text NOT NULL,
  system fitness.grade_system,
  position bigint NOT NULL,
  PRIMARY KEY (climb_id, position),
  CONSTRAINT climb_grade_value_nonempty CHECK (btrim(value) <> ''),
  CONSTRAINT climb_grade_position_nonnegative CHECK (position >= 0)
);
--> statement-breakpoint
CREATE INDEX climb_grade_lookup_idx ON fitness.climb_grade (system, value);
--> statement-breakpoint
CREATE TABLE fitness.pitch_grade (
  pitch_id uuid NOT NULL REFERENCES fitness.pitch (id) ON DELETE CASCADE,
  value text NOT NULL,
  system fitness.grade_system,
  position bigint NOT NULL,
  PRIMARY KEY (pitch_id, position),
  CONSTRAINT pitch_grade_value_nonempty CHECK (btrim(value) <> ''),
  CONSTRAINT pitch_grade_position_nonnegative CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE fitness.climbing_log_entry_grade (
  climbing_log_entry_id uuid NOT NULL REFERENCES fitness.climbing_entry (id) ON DELETE CASCADE,
  value text NOT NULL,
  system fitness.grade_system,
  position bigint NOT NULL,
  PRIMARY KEY (climbing_log_entry_id, position),
  CONSTRAINT climbing_log_entry_grade_value_nonempty CHECK (btrim(value) <> ''),
  CONSTRAINT climbing_log_entry_grade_position_nonnegative CHECK (position >= 0)
);
--> statement-breakpoint
-- Quiesce all old readers and writers before preparation.
-- https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_entry RENAME COLUMN climb_style TO legacy_climb_style;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
DROP CONSTRAINT climbing_entry_activity_unattached_date_pair,
ADD COLUMN climb_id uuid,
ADD COLUMN discipline fitness.climbing_discipline,
ADD COLUMN title text,
ADD COLUMN notes text,
ADD COLUMN model_converted boolean NOT NULL DEFAULT FALSE,
ADD CONSTRAINT climbing_entry_climb_owner_provider_fk FOREIGN KEY (user_id, provider_id, climb_id)
REFERENCES fitness.climb (user_id, provider_id, id) NOT VALID;
--> statement-breakpoint
-- Preserve the legacy meaning before creating the canonical outcome enum.
ALTER TYPE fitness.climbing_attempt_outcome RENAME TO legacy_climbing_attempt_outcome;
--> statement-breakpoint
CREATE TYPE fitness.attempt_outcome AS ENUM ('completed', 'failed');
--> statement-breakpoint
-- Quiesced conversion retains UUIDs and notes; the old ordinal is not global attempt order.
-- https://www.postgresql.org/docs/current/sql-altertable.html
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_attempt RENAME COLUMN attempt_index TO legacy_attempt_index;
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_attempt RENAME COLUMN outcome TO legacy_outcome;
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_attempt RENAME COLUMN failure_reason TO legacy_failure_reason;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt
RENAME CONSTRAINT climbing_attempt_index_positive TO climbing_attempt_legacy_index_positive;
--> statement-breakpoint
-- New count-only rows carry no legacy facts; existing facts remain untouched until conversion.
-- squawk-ignore ban-drop-not-null
ALTER TABLE fitness.climbing_attempt ALTER COLUMN legacy_attempt_index DROP NOT NULL;
--> statement-breakpoint
-- Quiesced conversion adds count-only occurrences with unknown legacy outcomes.
-- squawk-ignore ban-drop-not-null
ALTER TABLE fitness.climbing_attempt ALTER COLUMN legacy_outcome DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt
ADD COLUMN attempt_index bigint,
ADD COLUMN outcome fitness.attempt_outcome,
ADD COLUMN scope fitness.attempt_scope,
ADD COLUMN pitch_id uuid,
ADD COLUMN parent_attempt_id uuid,
ADD COLUMN rope_method fitness.rope_method,
ADD COLUMN solo boolean,
ADD COLUMN protection_used fitness.protection_style[],
ADD COLUMN used_preplaced_protection boolean,
ADD COLUMN used_aid boolean,
ADD COLUMN fell_or_hung boolean,
ADD COLUMN dabbed boolean,
ADD COLUMN received_beta boolean,
ADD COLUMN had_completed_before boolean,
ADD COLUMN prior_failed_attempts_ground_up boolean,
ADD CONSTRAINT climbing_attempt_index_positive CHECK (attempt_index > 0) NOT VALID,
ADD CONSTRAINT climbing_attempt_pitch_id_pitch_id_fk FOREIGN KEY (pitch_id) REFERENCES fitness.pitch (id) NOT VALID;
