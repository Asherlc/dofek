CREATE SCHEMA IF NOT EXISTS clickhouse;
--> statement-breakpoint
CREATE OR REPLACE VIEW clickhouse.v_activity AS
SELECT
  id,
  user_id,
  activity_type,
  name,
  started_at,
  ended_at
FROM fitness.v_activity;
--> statement-breakpoint
CREATE OR REPLACE VIEW clickhouse.v_activity_members AS
SELECT
  id AS activity_id,
  user_id,
  started_at,
  ended_at,
  unnest(member_activity_ids) AS member_activity_id
FROM fitness.v_activity;
