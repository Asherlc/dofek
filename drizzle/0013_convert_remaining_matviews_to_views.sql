-- Convert simple aggregation matviews to plain views.
-- fitness.deduped_sensor and fitness.activity_summary stay as materialized
-- views: they sit in the dedup graph rooted at v_activity (recursive CTE) and
-- are joined to themselves by analytics queries, which is too expensive to
-- recompute on every read. v_activity / v_sleep / deduped_sensor /
-- activity_summary are the canonical "expensive" matviews kept for performance.

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
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.v_body_measurement';
    EXECUTE format('CREATE VIEW fitness.v_body_measurement AS %s', view_definition);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'v_daily_metrics'
  ) THEN
    SELECT pg_get_viewdef(('fitness.v_daily_metrics')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.v_daily_metrics';
    EXECUTE format('CREATE VIEW fitness.v_daily_metrics AS %s', view_definition);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_matviews
    WHERE schemaname = 'fitness' AND matviewname = 'provider_stats'
  ) THEN
    SELECT pg_get_viewdef(('fitness.provider_stats')::regclass, true)
    INTO view_definition;
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS fitness.provider_stats';
    EXECUTE format('CREATE VIEW fitness.provider_stats AS %s', view_definition);
  END IF;

END
$$;
