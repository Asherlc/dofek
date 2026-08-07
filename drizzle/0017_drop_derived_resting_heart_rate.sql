DROP VIEW IF EXISTS clickhouse.derived_resting_heart_rate;

--> statement-breakpoint

DO $$
DECLARE
  relation_kind "char";
BEGIN
  SELECT pg_class.relkind
    INTO relation_kind
  FROM pg_class
  INNER JOIN pg_namespace
    ON pg_namespace.oid = pg_class.relnamespace
  WHERE pg_namespace.nspname = 'fitness'
    AND pg_class.relname = 'derived_resting_heart_rate';

  IF relation_kind = 'm' THEN
    DROP MATERIALIZED VIEW fitness.derived_resting_heart_rate;
  ELSIF relation_kind = 'v' THEN
    DROP VIEW fitness.derived_resting_heart_rate;
  ELSIF relation_kind IS NOT NULL THEN
    RAISE EXCEPTION 'fitness.derived_resting_heart_rate has unsupported relation kind %', relation_kind;
  END IF;
END;
$$;
