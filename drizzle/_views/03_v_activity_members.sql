-- Canonical definition of the fitness.v_activity_members view.
-- This view exposes every activity UUID in a deduped activity cluster as a
-- route/query alias for the canonical fitness.v_activity row.

CREATE OR REPLACE VIEW fitness.v_activity_members AS
SELECT
  id AS activity_id,
  user_id,
  started_at,
  ended_at,
  UNNEST(member_activity_ids) AS member_activity_id
FROM fitness.v_activity;
