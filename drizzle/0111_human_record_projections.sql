CREATE VIEW fitness.v_human_record_head AS
WITH heads AS (
SELECT
  target.user_id,
  target.identity_id,
  target.id AS target_id,
  target.change_id
FROM fitness.human_record_target AS target
WHERE NOT EXISTS (
  SELECT 1
  FROM fitness.human_record_target AS successor
  WHERE successor.user_id = target.user_id
    AND successor.identity_id = target.identity_id
    AND successor.predecessor_id = target.id
)
)
SELECT user_id, identity_id, target_id, change_id
FROM heads;
--> statement-breakpoint
CREATE VIEW fitness.v_human_record_field AS
SELECT
  head.user_id,
  head.identity_id,
  field.field,
  field.operation,
  field.value,
  field.target_id,
  field.change_id
FROM fitness.v_human_record_head AS head
CROSS JOIN LATERAL (
  WITH RECURSIVE history AS (
    SELECT target.id AS target_id, target.change_id, target.predecessor_id, target.fields, 0 AS depth
    FROM fitness.human_record_target AS target
    WHERE target.id = head.target_id
      AND target.identity_id = head.identity_id
      AND target.user_id = head.user_id

    UNION ALL

    SELECT predecessor.id, predecessor.change_id, predecessor.predecessor_id,
      predecessor.fields, history.depth + 1
    FROM history
    JOIN fitness.human_record_target AS predecessor
      ON predecessor.id = history.predecessor_id
      AND predecessor.identity_id = head.identity_id
      AND predecessor.user_id = head.user_id
  ),
  ranked AS (
    SELECT
      decision.key AS field,
      decision.value ->> 'operation' AS operation,
      decision.value -> 'value' AS value,
      history.target_id,
      history.change_id,
      row_number() OVER (PARTITION BY decision.key ORDER BY history.depth) AS decision_rank
    FROM history
    CROSS JOIN LATERAL jsonb_each(history.fields) AS decision
  )
  SELECT field, operation, value, target_id, change_id
  FROM ranked
  WHERE decision_rank = 1
) AS field;
--> statement-breakpoint
CREATE VIEW fitness.v_human_record_visibility AS
SELECT
  head.user_id,
  head.identity_id,
  visibility.deleted,
  visibility.target_id,
  visibility.change_id
FROM fitness.v_human_record_head AS head
CROSS JOIN LATERAL (
  WITH RECURSIVE history AS (
    SELECT target.id AS target_id, target.change_id, target.predecessor_id, target.deleted, 0 AS depth
    FROM fitness.human_record_target AS target
    WHERE target.id = head.target_id
      AND target.identity_id = head.identity_id
      AND target.user_id = head.user_id

    UNION ALL

    SELECT predecessor.id, predecessor.change_id, predecessor.predecessor_id,
      predecessor.deleted, history.depth + 1
    FROM history
    JOIN fitness.human_record_target AS predecessor
      ON predecessor.id = history.predecessor_id
      AND predecessor.identity_id = head.identity_id
      AND predecessor.user_id = head.user_id
  )
  SELECT deleted, target_id, change_id
  FROM history
  WHERE deleted IS NOT NULL
  ORDER BY depth
  LIMIT 1
) AS visibility;
