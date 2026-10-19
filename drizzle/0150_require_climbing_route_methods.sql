-- dofek: deployment-mode=maintenance
-- Prevent writes between the legacy preflight and installation of the graph guards.
-- https://www.postgresql.org/docs/current/explicit-locking.html
LOCK TABLE fitness.climb, fitness.climbing_log_entry, fitness.climbing_attempt
IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  missing record;
BEGIN
  SELECT attempt.id, entry.provider_id, entry.external_id, entry.id AS log_id
  INTO missing
  FROM fitness.climbing_attempt AS attempt
  JOIN fitness.climbing_log_entry AS entry ON entry.id = attempt.climbing_log_entry_id
  JOIN fitness.climb AS target ON target.id = entry.climb_id
  WHERE target.kind = 'route' AND attempt.rope_method IS NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Route attempt % in % log % requires a recorded rope method.',
      missing.id, missing.provider_id, COALESCE(missing.external_id, missing.log_id::text)
      USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_route_method_required',
        HINT = 'Correct missing methods from verified source evidence before applying this migration. Do not guess or delete attempts.';
  END IF;
END;
$$;
--> statement-breakpoint
-- A method belongs to an attempt; Climb kind lives on its shared definition.
-- CHECK cannot validate this cross-table relationship.
-- https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS
CREATE FUNCTION fitness.assert_climbing_route_methods(target_log_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  missing record;
BEGIN
  SELECT attempt.id, entry.provider_id, entry.external_id, entry.id AS log_id
  INTO missing
  FROM fitness.climbing_log_entry AS entry
  JOIN fitness.climb AS target ON target.id = entry.climb_id
  JOIN fitness.climbing_attempt AS attempt ON attempt.climbing_log_entry_id = entry.id
  WHERE entry.id = target_log_id AND target.kind = 'route' AND attempt.rope_method IS NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Route attempt % in % log % requires a recorded rope method.',
      missing.id, missing.provider_id, COALESCE(missing.external_id, missing.log_id::text)
      USING ERRCODE = '23514', CONSTRAINT = 'climbing_attempt_route_method_required',
        HINT = 'Record lead, top rope, follow, or unroped for every route attempt, including pitch attempts. Bouldering is exempt.';
  END IF;
END;
$$;
--> statement-breakpoint
-- Take relationship locks before writing, including currently unclassified climbs.
-- FOR SHARE also conflicts with changes to non-key kind and association columns.
-- https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS
CREATE FUNCTION fitness.lock_climbing_route_method_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_climb_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'climbing_attempt' THEN
    SELECT entry.climb_id INTO target_climb_id
    FROM fitness.climbing_log_entry AS entry
    WHERE entry.id = NEW.climbing_log_entry_id FOR SHARE;
  ELSE
    target_climb_id := NEW.climb_id;
  END IF;
  PERFORM target.id FROM fitness.climb AS target
  WHERE target.id = target_climb_id FOR SHARE;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER climbing_attempt_route_method_lock
BEFORE INSERT OR UPDATE OF id, rope_method, climbing_log_entry_id
ON fitness.climbing_attempt FOR EACH ROW
EXECUTE FUNCTION fitness.lock_climbing_route_method_target();
--> statement-breakpoint
CREATE TRIGGER climbing_log_entry_route_method_lock
BEFORE UPDATE OF climb_id ON fitness.climbing_log_entry FOR EACH ROW
EXECUTE FUNCTION fitness.lock_climbing_route_method_target();
--> statement-breakpoint
-- Validate final live rows so kind, target, and methods can be enriched atomically.
-- https://www.postgresql.org/docs/current/sql-createtrigger.html
CREATE FUNCTION fitness.climbing_route_methods_valid() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_log_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'climb' THEN
    FOR target_log_id IN
      SELECT entry.id FROM fitness.climbing_log_entry AS entry WHERE entry.climb_id = NEW.id
    LOOP
      PERFORM fitness.assert_climbing_route_methods(target_log_id);
    END LOOP;
  ELSE
    IF TG_TABLE_NAME = 'climbing_attempt' THEN
      SELECT attempt.climbing_log_entry_id INTO target_log_id
      FROM fitness.climbing_attempt AS attempt WHERE attempt.id = NEW.id;
    ELSE
      target_log_id := NEW.id;
    END IF;
    PERFORM fitness.assert_climbing_route_methods(target_log_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER climbing_attempt_route_method_required
AFTER INSERT OR UPDATE OF id, rope_method, climbing_log_entry_id ON fitness.climbing_attempt
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION fitness.climbing_route_methods_valid();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER climbing_log_entry_route_method_guard
AFTER UPDATE OF climb_id ON fitness.climbing_log_entry
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.climb_id IS DISTINCT FROM NEW.climb_id)
EXECUTE FUNCTION fitness.climbing_route_methods_valid();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER climb_route_method_guard
AFTER UPDATE OF kind ON fitness.climb
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.kind IS DISTINCT FROM NEW.kind)
EXECUTE FUNCTION fitness.climbing_route_methods_valid();
