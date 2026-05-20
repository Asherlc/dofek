CREATE OR REPLACE VIEW fitness.v_activity_members AS
SELECT
  id AS activity_id,
  user_id,
  started_at,
  ended_at,
  UNNEST(member_activity_ids) AS member_activity_id
FROM fitness.v_activity;

--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS clickhouse;

--> statement-breakpoint

CREATE OR REPLACE VIEW clickhouse.v_activity_members AS
SELECT
  activity_id,
  user_id,
  started_at,
  ended_at,
  member_activity_id
FROM fitness.v_activity_members;
