CREATE TABLE fitness.human_food_nutrient_decision (
  target_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  user_id uuid NOT NULL,
  nutrient_id text NOT NULL REFERENCES fitness.nutrient (id),
  operation text NOT NULL,
  amount real,
  PRIMARY KEY (target_id, nutrient_id),
  CONSTRAINT human_food_nutrient_decision_target_fk
    FOREIGN KEY (target_id, identity_id, user_id)
    REFERENCES fitness.human_record_target (id, identity_id, user_id),
  CONSTRAINT human_food_nutrient_decision_value_valid CHECK (
    (operation = 'clear' AND amount IS NULL)
    OR (operation = 'set' AND (amount IS NULL OR amount >= 0))
  )
);
--> statement-breakpoint
CREATE TRIGGER human_food_nutrient_decision_append_only
BEFORE UPDATE OR DELETE ON fitness.human_food_nutrient_decision
FOR EACH ROW EXECUTE FUNCTION fitness.reject_human_record_mutation();
--> statement-breakpoint
CREATE VIEW fitness.v_human_food_nutrient_decision AS
SELECT
  head.user_id,
  head.identity_id,
  decision.nutrient_id,
  decision.operation,
  decision.amount,
  decision.target_id
FROM fitness.v_human_record_head AS head
CROSS JOIN LATERAL (
  WITH RECURSIVE history AS (
    SELECT target.id, target.predecessor_id, 0 AS depth
    FROM fitness.human_record_target AS target
    WHERE target.id = head.target_id

    UNION ALL

    SELECT predecessor.id, predecessor.predecessor_id, history.depth + 1
    FROM history
    JOIN fitness.human_record_target AS predecessor
      ON predecessor.id = history.predecessor_id
      AND predecessor.identity_id = head.identity_id
      AND predecessor.user_id = head.user_id
  ), ranked AS (
    SELECT
      nutrient.*,
      history.depth,
      row_number() OVER (
        PARTITION BY nutrient.nutrient_id
        ORDER BY history.depth
      ) AS decision_rank
    FROM history
    JOIN fitness.human_food_nutrient_decision AS nutrient
      ON nutrient.target_id = history.id
  )
  SELECT * FROM ranked WHERE decision_rank = 1
) AS decision;
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
