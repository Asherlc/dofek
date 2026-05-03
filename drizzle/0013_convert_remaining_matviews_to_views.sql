-- Move selected view definitions to non-materialized PostgreSQL views.
-- Keep existing plain-view definitions for environments where migration already ran.

DO $$
DECLARE
  view_definition text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'v_body_measurement'
  ) THEN
    SELECT pg_get_viewdef(('fitness.v_body_measurement')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.v_body_measurement CASCADE';
    EXECUTE format('CREATE VIEW fitness.v_body_measurement AS %s', view_definition);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'v_daily_metrics'
  ) THEN
    SELECT pg_get_viewdef(('fitness.v_daily_metrics')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics CASCADE';
    EXECUTE format('CREATE VIEW fitness.v_daily_metrics AS %s', view_definition);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'activity_summary'
  ) THEN
    SELECT pg_get_viewdef(('fitness.activity_summary')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary CASCADE';
    EXECUTE format('CREATE VIEW fitness.activity_summary AS %s', view_definition);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'provider_stats'
  ) THEN
    SELECT pg_get_viewdef(('fitness.provider_stats')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.provider_stats CASCADE';
    EXECUTE format('CREATE VIEW fitness.provider_stats AS %s', view_definition);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'derived_resting_heart_rate'
  ) THEN
    SELECT pg_get_viewdef(('fitness.derived_resting_heart_rate')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.derived_resting_heart_rate CASCADE';
    EXECUTE format('CREATE VIEW fitness.derived_resting_heart_rate AS %s', view_definition);
  END IF;
END
$$;
