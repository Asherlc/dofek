-- DISTINCT keeps this view read-only, including INSERTs into the append-only ledger.
CREATE VIEW fitness.v_human_record_head AS
SELECT DISTINCT
  target.user_id,
  target.identity_id,
  target.id AS target_id,
  target.change_id
FROM fitness.human_record_target AS target
WHERE NOT EXISTS (
  SELECT 1
  FROM fitness.human_record_target AS successor
  WHERE
    successor.user_id = target.user_id
    AND successor.identity_id = target.identity_id
    AND successor.predecessor_id = target.id
);
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
    SELECT
      target.id AS target_id,
      target.change_id,
      target.predecessor_id,
      target.fields,
      0 AS depth
    FROM fitness.human_record_target AS target
    WHERE
      target.id = head.target_id
      AND target.identity_id = head.identity_id
      AND target.user_id = head.user_id

    UNION ALL

    SELECT
      predecessor.id,
      predecessor.change_id,
      predecessor.predecessor_id,
      predecessor.fields,
      history.depth + 1 AS depth
    FROM history
    INNER JOIN fitness.human_record_target AS predecessor
      ON
        history.predecessor_id = predecessor.id
        AND head.identity_id = predecessor.identity_id
        AND head.user_id = predecessor.user_id
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

  SELECT
    head.user_id,
    head.identity_id,
    ranked.field,
    ranked.operation,
    ranked.value,
    ranked.target_id,
    ranked.change_id
  FROM ranked
  WHERE ranked.decision_rank = 1
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
    SELECT
      target.id AS target_id,
      target.change_id,
      target.predecessor_id,
      target.deleted,
      0 AS depth
    FROM fitness.human_record_target AS target
    WHERE
      target.id = head.target_id
      AND target.identity_id = head.identity_id
      AND target.user_id = head.user_id

    UNION ALL

    SELECT
      predecessor.id,
      predecessor.change_id,
      predecessor.predecessor_id,
      predecessor.deleted,
      history.depth + 1 AS depth
    FROM history
    INNER JOIN fitness.human_record_target AS predecessor
      ON
        history.predecessor_id = predecessor.id
        AND head.identity_id = predecessor.identity_id
        AND head.user_id = predecessor.user_id
  )

  SELECT
    head.user_id,
    head.identity_id,
    history.deleted,
    history.target_id,
    history.change_id
  FROM history
  WHERE history.deleted IS NOT NULL
  ORDER BY history.depth
  LIMIT 1
) AS visibility;
