-- Drop the Postgres dedup-graph matviews. All consumers now read from
-- ClickHouse (analytics.deduped_sensor, analytics.activity_summary) which
-- mirrors fitness.metric_stream + fitness.v_activity via PeerDB CDC.
--
-- These Postgres matviews could never be refreshed performantly on real data
-- and have been a constant source of broken deploys (long-running REFRESH,
-- failed self-heal, missing populated rows). Removing them unblocks deploys
-- and forces the analytics path to live entirely in ClickHouse.

DROP MATERIALIZED VIEW IF EXISTS fitness.activity_summary CASCADE;

--> statement-breakpoint

DROP MATERIALIZED VIEW IF EXISTS fitness.deduped_sensor CASCADE;
