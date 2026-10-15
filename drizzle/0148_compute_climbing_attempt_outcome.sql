-- Source result labels are raw per-occurrence facts; completion is a serving projection.
-- https://www.postgresql.org/docs/current/sql-createfunction.html
-- The explicit trim set matches ECMAScript String.prototype.trim, including Unicode whitespace.
-- https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.trim
CREATE FUNCTION fitness.climbing_attempt_outcome(source_result TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN normalized.label IN (
      'completed', 'sent', 'on sight', 'onsight', 'aid onsight', 'flash', 'aid flash',
      'clean', 'send', 'redpoint', 'pinkpoint', 'greenpoint', 'repeat',
      'ground-up redpoint', 'dog', 'hang dog', 'tick', 'dab'
    ) THEN 'completed'
    WHEN normalized.label IN ('attempt', 'failed') THEN 'failed'
  END
  FROM (
    SELECT lower(btrim(source_result, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) AS label
  ) AS normalized;
$$;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt ADD COLUMN source_result TEXT;
--> statement-breakpoint
-- Preserve only the occurrence described by the retained original source label.
-- Counts created anonymous occurrences; a log-level label must not be copied onto those.
-- Known outcomes without one matching raw occurrence abort the transactional cutover.
-- https://www.postgresql.org/docs/current/plpgsql-control-structures.html
DO $$
DECLARE
  source record;
  known_count bigint;
  whole_count bigint;
  described_count bigint;
  target_id uuid;
  described_id uuid;
  only_id uuid;
  target_scope text;
  prior_outcome text;
  normalized_result text;
BEGIN
  FOR source IN
    SELECT entry.id,
      CASE entry.provider_id
        WHEN 'mountain-project' THEN CASE
          WHEN climb.kind = 'boulder' THEN entry.raw ->> 'Style'
          ELSE entry.raw ->> 'Lead Style'
        END
        WHEN 'openbeta' THEN entry.raw ->> 'attemptType'
        WHEN 'thecrag' THEN CASE
          WHEN nullif(btrim(entry.raw #>> '{ascent,tick,label}', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') IS NOT NULL
            THEN entry.raw #>> '{ascent,tick,label}'
          ELSE entry.raw #>> '{ascent,tick,name}'
        END
        WHEN 'kaya' THEN entry.raw #>> '{ascent_type,name}'
        WHEN 'kaya-export' THEN entry.raw ->> 'ascentType'
      END AS result_label
    FROM fitness.climbing_log_entry AS entry
    LEFT JOIN fitness.climb AS climb ON climb.id = entry.climb_id
  LOOP
    normalized_result := lower(btrim(source.result_label, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
    SELECT count(*), min(attempt.id::text)::uuid
    INTO known_count, target_id
    FROM fitness.climbing_attempt AS attempt
    WHERE attempt.climbing_log_entry_id = source.id AND attempt.outcome IS NOT NULL;

    IF known_count > 0 THEN
      SELECT attempt.scope::text, attempt.outcome::text INTO target_scope, prior_outcome
      FROM fitness.climbing_attempt AS attempt WHERE attempt.id = target_id;
      IF known_count <> 1 OR target_scope <> 'climb'
        OR prior_outcome IS DISTINCT FROM fitness.climbing_attempt_outcome(source.result_label) THEN
        RAISE EXCEPTION 'Cannot reconstruct retained source result for climbing log %: missing, conflicting, or ambiguous raw occurrence evidence.', source.id;
      END IF;
      UPDATE fitness.climbing_attempt SET source_result = source.result_label WHERE id = target_id;
    ELSIF normalized_result = 'fell/hung' THEN
      SELECT count(*),
        count(*) FILTER (WHERE num_nonnulls(
          attempt.attempt_index, attempt.rope_method, attempt.solo, attempt.protection_used,
          attempt.used_preplaced_protection, attempt.used_aid, attempt.fell_or_hung,
          attempt.dabbed, attempt.received_beta, attempt.had_completed_before,
          attempt.prior_failed_attempts_ground_up, attempt.notes
        ) > 0),
        (array_agg(attempt.id) FILTER (WHERE num_nonnulls(
          attempt.attempt_index, attempt.rope_method, attempt.solo, attempt.protection_used,
          attempt.used_preplaced_protection, attempt.used_aid, attempt.fell_or_hung,
          attempt.dabbed, attempt.received_beta, attempt.had_completed_before,
          attempt.prior_failed_attempts_ground_up, attempt.notes
        ) > 0))[1],
        (array_agg(attempt.id))[1]
      INTO whole_count, described_count, described_id, only_id
      FROM fitness.climbing_attempt AS attempt
      WHERE attempt.climbing_log_entry_id = source.id AND attempt.scope = 'climb';
      target_id := CASE WHEN whole_count = 1 THEN only_id WHEN described_count = 1 THEN described_id END;
      UPDATE fitness.climbing_attempt SET source_result = source.result_label
      WHERE id = target_id AND fell_or_hung IS DISTINCT FROM FALSE;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM fitness.climbing_attempt
    WHERE outcome::text IS DISTINCT FROM fitness.climbing_attempt_outcome(source_result)
  ) THEN
    RAISE EXCEPTION 'Cannot reconstruct every retained source result without changing existing climbing outcomes.';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt ADD CONSTRAINT climbing_attempt_source_result_nonempty
CHECK (source_result IS NULL OR btrim(source_result, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '') NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt VALIDATE CONSTRAINT climbing_attempt_source_result_nonempty;
--> statement-breakpoint
CREATE VIEW fitness.v_climbing_attempt AS
SELECT
  attempt.id,
  attempt.climbing_log_entry_id,
  attempt.scope,
  attempt.pitch_id,
  attempt.parent_attempt_id,
  attempt.attempt_index,
  fitness.climbing_attempt_outcome(attempt.source_result) AS outcome,
  attempt.rope_method,
  attempt.solo,
  attempt.protection_used,
  attempt.used_preplaced_protection,
  attempt.used_aid,
  attempt.fell_or_hung,
  attempt.dabbed,
  attempt.received_beta,
  attempt.had_completed_before,
  attempt.prior_failed_attempts_ground_up,
  attempt.notes,
  attempt.created_at,
  attempt.source_result
FROM fitness.climbing_attempt AS attempt;

--> statement-breakpoint
-- Replacing the projection retains its identity and grants while removing its stored-outcome dependency.
-- https://www.postgresql.org/docs/current/sql-createview.html
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
  FROM fitness.v_climbing_attempt AS attempt
  WHERE attempt.climbing_log_entry_id = entry.id
) AS attempts ON TRUE;

--> statement-breakpoint
ALTER TABLE fitness.climbing_attempt DROP COLUMN outcome;
--> statement-breakpoint
-- The computed projection returns text, so the storage-only enum has no remaining consumers.
-- https://www.postgresql.org/docs/current/sql-droptype.html
-- squawk-ignore ban-drop-type
DROP TYPE fitness.ATTEMPT_OUTCOME;
