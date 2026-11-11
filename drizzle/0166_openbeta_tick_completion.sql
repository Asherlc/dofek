-- Interpret unlabeled OpenBeta ticks as completion, including already-synced records.
-- Recover source labels discarded by older adapters from retained raw facts.
-- https://www.postgresql.org/docs/current/sql-createview.html
CREATE OR REPLACE VIEW fitness.v_climbing_attempt AS
WITH projected_attempts AS (
  SELECT
    attempt.*,
    climb.kind AS climb_kind,
    entry.provider_id = 'mountain-project'
    AND entry.discipline = 'rock_climbing'
    AND climb.kind = 'route'
    AND attempt.scope = 'climb'
    AND attempt.rope_method = 'top_rope'
    AND attempt.source_result IS NULL AS mountain_project_top_rope,
    entry.provider_id = 'openbeta'
    AND attempt.scope = 'climb'
    AND attempt.source_result IS NULL
    AND entry.raw ->> 'attemptType' IS NULL AS openbeta_unlabeled,
    CASE
      WHEN entry.provider_id = 'openbeta' AND attempt.scope = 'climb'
        THEN entry.raw ->> 'attemptType'
    END AS openbeta_source_result
  FROM fitness.climbing_attempt AS attempt
  LEFT JOIN fitness.climbing_log_entry AS entry ON attempt.climbing_log_entry_id = entry.id
  LEFT JOIN fitness.climb AS climb ON entry.climb_id = climb.id
)

SELECT
  attempt.id,
  attempt.climbing_log_entry_id,
  attempt.scope,
  attempt.pitch_id,
  attempt.parent_attempt_id,
  attempt.attempt_index,
  CASE
    WHEN attempt.mountain_project_top_rope OR attempt.openbeta_unlabeled THEN 'completed'
    ELSE fitness.climbing_attempt_outcome(coalesce(attempt.source_result, attempt.openbeta_source_result))
  END AS outcome,
  attempt.rope_method,
  attempt.solo,
  attempt.protection_used,
  attempt.used_preplaced_protection,
  coalesce(attempt.used_aid, CASE WHEN attempt.mountain_project_top_rope OR attempt.openbeta_unlabeled THEN FALSE END) AS used_aid,
  coalesce(attempt.fell_or_hung, CASE WHEN attempt.mountain_project_top_rope OR attempt.openbeta_unlabeled THEN FALSE END) AS fell_or_hung,
  coalesce(attempt.dabbed, CASE WHEN attempt.openbeta_unlabeled AND attempt.climb_kind = 'boulder' THEN FALSE END) AS dabbed,
  attempt.received_beta,
  attempt.had_completed_before,
  attempt.prior_failed_attempts_ground_up,
  attempt.notes,
  attempt.created_at,
  attempt.source_result
FROM projected_attempts AS attempt;
