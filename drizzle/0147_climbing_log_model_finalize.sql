-- Finalize only after the bounded operational conversion, with readers/writers quiesced.
-- Fresh databases have no legacy rows and can apply both schema-only stages directly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fitness.climbing_entry WHERE NOT model_converted) THEN
    RAISE EXCEPTION 'Climbing model conversion is incomplete. Run the climbing-log cutover before finalization.';
  END IF;
  IF EXISTS (SELECT 1 FROM fitness.climbing_entry WHERE climb_id IS NULL OR discipline IS DISTINCT FROM 'rock_climbing') THEN
    RAISE EXCEPTION 'Climbing model conversion must preserve each legacy climb and its rock-climbing discipline.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fitness.climbing_entry AS entry
    WHERE NOT EXISTS (
      SELECT 1 FROM fitness.climbing_attempt AS attempt WHERE attempt.climbing_entry_id = entry.id
    )
  ) THEN
    RAISE EXCEPTION 'Climbing model conversion left a log without a recorded attempt.';
  END IF;
  IF EXISTS (SELECT 1 FROM fitness.climbing_attempt WHERE scope IS NULL) THEN
    RAISE EXCEPTION 'Climbing model conversion left an attempt without its recorded scope.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fitness.climbing_attempt AS attempt
    JOIN fitness.climbing_entry AS entry ON entry.id = attempt.climbing_entry_id
    LEFT JOIN fitness.pitch AS pitch ON pitch.id = attempt.pitch_id
    LEFT JOIN fitness.climbing_attempt AS parent ON parent.id = attempt.parent_attempt_id
    WHERE (attempt.scope = 'climb' AND (attempt.pitch_id IS NOT NULL OR attempt.parent_attempt_id IS NOT NULL))
      OR (attempt.pitch_id IS NOT NULL AND pitch.climb_id IS DISTINCT FROM entry.climb_id)
      OR (attempt.parent_attempt_id IS NOT NULL AND (
        parent.id IS NULL OR parent.climbing_entry_id IS DISTINCT FROM attempt.climbing_entry_id
        OR parent.scope IS DISTINCT FROM 'climb'
      ))
      OR attempt.parent_attempt_id = attempt.id
  ) THEN
    RAISE EXCEPTION 'Climbing model conversion contains an invalid attempt target or parent graph.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fitness.climbing_entry
    WHERE external_id IS NOT NULL
    GROUP BY user_id, provider_id, external_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Climbing log occurrence identities conflict. Resolve the source occurrences before finalization.';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestry(origin_id, ancestor_id) AS (
      SELECT id, parent_area_id FROM fitness.area WHERE parent_area_id IS NOT NULL
      UNION
      SELECT ancestry.origin_id, parent.parent_area_id
      FROM ancestry INNER JOIN fitness.area AS parent ON parent.id = ancestry.ancestor_id
      WHERE parent.parent_area_id IS NOT NULL
    )
    SELECT 1 FROM ancestry WHERE origin_id = ancestor_id
  ) THEN
    RAISE EXCEPTION 'Climbing model conversion contains an area hierarchy cycle.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fitness.climb AS climb
    WHERE NOT EXISTS (SELECT 1 FROM fitness.climbing_entry AS entry WHERE entry.climb_id = climb.id)
  ) OR EXISTS (
    WITH RECURSIVE needed_areas(id) AS (
      SELECT area_id FROM fitness.climb WHERE area_id IS NOT NULL
      UNION
      SELECT area.parent_area_id FROM fitness.area AS area INNER JOIN needed_areas ON area.id = needed_areas.id
      WHERE area.parent_area_id IS NOT NULL
    )
    SELECT 1 FROM fitness.area AS area WHERE NOT EXISTS (SELECT 1 FROM needed_areas WHERE needed_areas.id = area.id)
  ) THEN
    RAISE EXCEPTION 'Climbing model conversion left unreferenced source objects. Complete conversion cleanup before finalization.';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry VALIDATE CONSTRAINT climbing_entry_climb_owner_provider_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt VALIDATE CONSTRAINT climbing_attempt_index_positive;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt VALIDATE CONSTRAINT climbing_attempt_pitch_id_pitch_id_fk;
--> statement-breakpoint
DROP VIEW fitness.v_climbing_entry;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
DROP CONSTRAINT climbing_entry_activity_owner_fk;
--> statement-breakpoint
-- Quiesced transactional cutover: CONCURRENTLY cannot run inside this transaction.
-- https://www.postgresql.org/docs/current/sql-dropindex.html
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_entry_activity_external_id_idx;
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_entry_grade_lookup_idx;
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_entry_unattached_date_idx;
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_entry_mountain_project_external_id_idx;
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_entry_openbeta_external_id_idx;
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_entry_thecrag_external_id_idx;
--> statement-breakpoint
ALTER TABLE fitness.climbing_entry
DROP COLUMN climb_type,
DROP COLUMN grade,
DROP COLUMN grade_system,
DROP COLUMN route_name,
DROP COLUMN location_path,
DROP COLUMN result_style,
DROP COLUMN attempt_count,
DROP COLUMN legacy_climb_style,
DROP COLUMN route_protection,
DROP COLUMN model_converted;
--> statement-breakpoint
-- Maintenance cutover; all consumers resume using the canonical name together.
-- https://www.postgresql.org/docs/current/sql-altertable.html
ALTER TABLE fitness.climbing_entry RENAME TO climbing_log_entry;
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_log_entry RENAME COLUMN unattached_date TO climbed_on;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_pkey TO climbing_log_entry_pkey;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_user_id_user_profile_id_fk TO climbing_log_entry_user_id_user_profile_id_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_provider_id_provider_id_fk TO climbing_log_entry_provider_id_provider_id_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_climb_owner_provider_fk TO climbing_log_entry_climb_owner_provider_fk;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_external_id_nonempty TO climbing_log_entry_external_id_nonempty;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_source_name_nonempty TO climbing_log_entry_source_name_nonempty;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_board_valid TO climbing_log_entry_board_valid;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
RENAME CONSTRAINT climbing_entry_wall_angle_valid TO climbing_log_entry_wall_angle_valid;
--> statement-breakpoint
-- SET NULL affects only the association, retaining the log's nonnullable owner.
-- https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK
ALTER TABLE fitness.climbing_log_entry
ADD CONSTRAINT climbing_log_entry_activity_owner_fk FOREIGN KEY (user_id, activity_id)
REFERENCES fitness.activity (user_id, id) ON DELETE SET NULL (activity_id) NOT VALID,
ADD CONSTRAINT climbing_log_entry_title_nonempty CHECK (title IS NULL OR btrim(title) <> '') NOT VALID,
ADD CONSTRAINT climbing_log_entry_notes_nonempty CHECK (notes IS NULL OR btrim(notes) <> '') NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.climbing_log_entry
VALIDATE CONSTRAINT climbing_log_entry_activity_owner_fk,
VALIDATE CONSTRAINT climbing_log_entry_title_nonempty,
VALIDATE CONSTRAINT climbing_log_entry_notes_nonempty;
--> statement-breakpoint
ALTER INDEX fitness.climbing_entry_activity_idx RENAME TO climbing_log_entry_activity_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX climbing_log_entry_source_external_id_idx
ON fitness.climbing_log_entry (user_id, provider_id, external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX climbing_log_entry_climb_idx ON fitness.climbing_log_entry (climb_id);
--> statement-breakpoint
CREATE INDEX climbing_log_entry_source_date_idx
ON fitness.climbing_log_entry (user_id, provider_id, climbed_on);
--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE fitness.climbing_attempt RENAME COLUMN climbing_entry_id TO climbing_log_entry_id;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt
RENAME CONSTRAINT climbing_attempt_climbing_entry_id_fkey TO climbing_attempt_climbing_log_entry_id_climbing_log_entry_id_fk;
--> statement-breakpoint
-- Quiesced transactional replacement of the legacy log-local ordinal index.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fitness.climbing_attempt_entry_index_idx;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt
DROP COLUMN legacy_attempt_index,
DROP COLUMN legacy_outcome,
DROP COLUMN legacy_failure_reason;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt ALTER COLUMN scope SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX climbing_attempt_log_id_idx ON fitness.climbing_attempt (climbing_log_entry_id, id);
--> statement-breakpoint
CREATE INDEX climbing_attempt_pitch_idx ON fitness.climbing_attempt (pitch_id);
--> statement-breakpoint
CREATE INDEX climbing_attempt_parent_idx ON fitness.climbing_attempt (parent_attempt_id);
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt
ADD CONSTRAINT climbing_attempt_parent_same_log_fk
FOREIGN KEY (climbing_log_entry_id, parent_attempt_id)
REFERENCES fitness.climbing_attempt (climbing_log_entry_id, id) NOT VALID,
ADD CONSTRAINT climbing_attempt_scope_valid CHECK (scope = 'pitch' OR (pitch_id IS NULL AND parent_attempt_id IS NULL)) NOT VALID,
ADD CONSTRAINT climbing_attempt_parent_distinct CHECK (parent_attempt_id <> id) NOT VALID,
ADD CONSTRAINT climbing_attempt_protection_valid CHECK (array_position(protection_used, NULL) IS NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt
VALIDATE CONSTRAINT climbing_attempt_parent_same_log_fk,
VALIDATE CONSTRAINT climbing_attempt_scope_valid,
VALIDATE CONSTRAINT climbing_attempt_parent_distinct,
VALIDATE CONSTRAINT climbing_attempt_protection_valid;
--> statement-breakpoint
ALTER INDEX fitness.climbing_attempt_entry_idx RENAME TO climbing_attempt_log_entry_idx;
--> statement-breakpoint
DROP FUNCTION fitness.climbing_location_path_valid(JSONB);
--> statement-breakpoint
DROP TYPE fitness.CLIMBING_CLIMB_TYPE;
--> statement-breakpoint
DROP TYPE fitness.LEGACY_CLIMBING_ATTEMPT_OUTCOME;
--> statement-breakpoint
DROP TYPE fitness.CLIMBING_FAILURE_REASON;
--> statement-breakpoint
DROP TYPE fitness.CLIMBING_GRADE_SYSTEM;
--> statement-breakpoint
-- Cross-table checks lock referenced rows so simultaneous target edits cannot invalidate a try.
-- https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS
CREATE FUNCTION fitness.climbing_attempt_graph_valid() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  log_climb uuid;
  pitch_climb uuid;
  parent_scope fitness.attempt_scope;
BEGIN
  IF NEW.pitch_id IS NOT NULL THEN
    SELECT entry.climb_id INTO log_climb FROM fitness.climbing_log_entry AS entry
    WHERE entry.id = NEW.climbing_log_entry_id FOR SHARE;
    SELECT target.climb_id INTO pitch_climb FROM fitness.pitch AS target
    WHERE target.id = NEW.pitch_id FOR SHARE;
    IF FOUND AND pitch_climb IS DISTINCT FROM log_climb THEN
      RAISE EXCEPTION 'The recorded pitch must belong to the log''s Climb.'
        USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_pitch_target_valid';
    END IF;
  END IF;
  IF NEW.parent_attempt_id IS NOT NULL THEN
    SELECT parent.scope INTO parent_scope FROM fitness.climbing_attempt AS parent
    WHERE parent.id = NEW.parent_attempt_id AND parent.climbing_log_entry_id = NEW.climbing_log_entry_id
    FOR SHARE;
    IF FOUND AND parent_scope <> 'climb' THEN
      RAISE EXCEPTION 'A pitch attempt can only have a whole-Climb parent.'
        USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_parent_scope_valid';
    END IF;
  END IF;
  IF NEW.scope <> 'climb' AND EXISTS (
    SELECT 1 FROM fitness.climbing_attempt AS child WHERE child.parent_attempt_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'An attempt with pitch children must retain whole-Climb scope.'
      USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_parent_scope_valid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER climbing_attempt_graph_guard
BEFORE INSERT OR UPDATE OF scope, pitch_id, parent_attempt_id, climbing_log_entry_id
ON fitness.climbing_attempt FOR EACH ROW EXECUTE FUNCTION fitness.climbing_attempt_graph_valid();
--> statement-breakpoint
CREATE FUNCTION fitness.climbing_log_entry_pitch_targets_valid() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT target_pitch.climb_id FROM fitness.climbing_attempt AS attempt
    INNER JOIN fitness.pitch AS target_pitch ON target_pitch.id = attempt.pitch_id
    WHERE attempt.climbing_log_entry_id = NEW.id FOR SHARE OF target_pitch
  LOOP
    IF target.climb_id IS DISTINCT FROM NEW.climb_id THEN
      RAISE EXCEPTION 'Changing the log''s Climb would invalidate its recorded pitch.'
        USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_pitch_target_valid';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER climbing_log_entry_pitch_guard BEFORE UPDATE OF climb_id
ON fitness.climbing_log_entry FOR EACH ROW EXECUTE FUNCTION fitness.climbing_log_entry_pitch_targets_valid();
--> statement-breakpoint
CREATE FUNCTION fitness.pitch_attempt_targets_valid() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT entry.climb_id FROM fitness.climbing_attempt AS attempt
    INNER JOIN fitness.climbing_log_entry AS entry ON entry.id = attempt.climbing_log_entry_id
    WHERE attempt.pitch_id = NEW.id FOR SHARE OF entry
  LOOP
    IF target.climb_id IS DISTINCT FROM NEW.climb_id THEN
      RAISE EXCEPTION 'Changing the pitch''s Climb would invalidate a recorded attempt.'
        USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_pitch_target_valid';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pitch_attempt_target_guard BEFORE UPDATE OF climb_id
ON fitness.pitch FOR EACH ROW EXECUTE FUNCTION fitness.pitch_attempt_targets_valid();
--> statement-breakpoint
-- Current shared definitions and recorded attempts are serving projections, never duplicate storage.
-- https://www.postgresql.org/docs/current/sql-createview.html
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
  entry.hold_type,
  entry.source_name,
  entry.raw,
  entry.provider_absent_at,
  entry.created_at,
  climb.name AS climb_name,
  climb.kind AS climb_kind,
  climb.setting,
  climb.route_protection,
  climb.coordinates,
  coalesce((
    SELECT jsonb_agg(jsonb_build_object('value', component.value, 'system', component.system) ORDER BY component.position)
    FROM fitness.climb_grade AS component
    WHERE component.climb_id = climb.id
  ), '[]'::JSONB) AS published_grades,
  coalesce((
    SELECT jsonb_agg(jsonb_build_object('value', component.value, 'system', component.system) ORDER BY component.position)
    FROM fitness.climbing_log_entry_grade AS component
    WHERE component.climbing_log_entry_id = entry.id
  ), '[]'::JSONB) AS reported_grades,
  coalesce((
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
      WHERE NOT parent.id = any(child.visited)
    )

    SELECT
      jsonb_agg(
        jsonb_build_object(
          'id', chain.id, 'userId', chain.user_id, 'providerId', chain.provider_id,
          'name', chain.name, 'externalId', chain.external_id, 'parentAreaId', chain.parent_area_id,
          'coordinates', CASE
            WHEN chain.coordinates IS NOT NULL
              THEN jsonb_build_object('latitude', chain.coordinates[1], 'longitude', chain.coordinates[0])
          END
        )
        ORDER BY chain.depth DESC
      ) AS area_path
    FROM chain
  ), '[]'::JSONB) AS area_path,
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
    count(*) FILTER (WHERE attempt.scope = 'climb') AS recorded_climb_attempt_count,
    count(*) FILTER (WHERE attempt.scope = 'pitch') AS recorded_pitch_attempt_count,
    CASE
      WHEN bool_or(attempt.outcome = 'completed') FILTER (WHERE attempt.scope = 'climb') THEN 'completed'
      WHEN
        count(*) FILTER (WHERE attempt.scope = 'climb') > 0
        AND bool_and(coalesce(attempt.outcome = 'failed', FALSE)) FILTER (WHERE attempt.scope = 'climb') THEN 'failed'
    END AS recorded_climb_outcome,
    CASE
      WHEN bool_or(
        attempt.outcome = 'completed' AND attempt.fell_or_hung = FALSE AND attempt.used_aid = FALSE
        AND (climb.kind = 'route' OR (climb.kind = 'boulder' AND attempt.dabbed = FALSE))
      ) FILTER (WHERE attempt.scope = 'climb') THEN TRUE
      WHEN count(*) FILTER (WHERE attempt.scope = 'climb') > 0 AND bool_and(coalesce(
        attempt.outcome = 'failed' OR attempt.fell_or_hung = TRUE OR attempt.used_aid = TRUE
        OR (climb.kind = 'boulder' AND attempt.dabbed = TRUE), FALSE
      )) FILTER (WHERE attempt.scope = 'climb') THEN FALSE
    END AS free_send
  FROM fitness.climbing_attempt AS attempt
  WHERE attempt.climbing_log_entry_id = entry.id
) AS attempts ON TRUE;
