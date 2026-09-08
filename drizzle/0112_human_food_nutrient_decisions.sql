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
WITH RECURSIVE history AS (
  SELECT
    head.user_id,
    head.identity_id,
    target.id,
    target.predecessor_id,
    0 AS depth
  FROM fitness.v_human_record_head AS head
  INNER JOIN fitness.human_record_target AS target
    ON head.target_id = target.id

  UNION ALL

  SELECT
    history.user_id,
    history.identity_id,
    predecessor.id,
    predecessor.predecessor_id,
    history.depth + 1 AS depth
  FROM history
  INNER JOIN fitness.human_record_target AS predecessor
    ON
      history.predecessor_id = predecessor.id
      AND history.identity_id = predecessor.identity_id
      AND history.user_id = predecessor.user_id
),

ranked AS (
  SELECT
    history.user_id,
    history.identity_id,
    nutrient.nutrient_id,
    nutrient.operation,
    nutrient.amount,
    nutrient.target_id,
    row_number() OVER (
      PARTITION BY history.user_id, history.identity_id, nutrient.nutrient_id
      ORDER BY history.depth
    ) AS decision_rank
  FROM history
  INNER JOIN fitness.human_food_nutrient_decision AS nutrient
    ON history.id = nutrient.target_id
)

SELECT
  user_id,
  identity_id,
  nutrient_id,
  operation,
  amount,
  target_id
FROM ranked
WHERE decision_rank = 1;
--> statement-breakpoint
SELECT fitness.refresh_account_erasure_write_fences();
