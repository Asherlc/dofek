ALTER TABLE fitness.food_entry ALTER COLUMN food_name DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE fitness.food_entry ADD COLUMN IF NOT EXISTS source_name text;
--> statement-breakpoint
ALTER TABLE fitness.food_entry ADD COLUMN IF NOT EXISTS started_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE fitness.food_entry ADD COLUMN IF NOT EXISTS ended_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE fitness.food_entry_nutrition ADD COLUMN IF NOT EXISTS water_ml integer;
--> statement-breakpoint
WITH migrated_entries AS (
  INSERT INTO fitness.food_entry (
    provider_id,
    user_id,
    external_id,
    date,
    food_name,
    source_name,
    started_at,
    ended_at,
    raw,
    confirmed
  )
  SELECT
    nd.provider_id,
    nd.user_id,
    'nutrition-daily:' || nd.user_id::text || ':' || nd.provider_id || ':' || nd.date::text,
    nd.date,
    NULL,
    nd.provider_id,
    nd.date::timestamp with time zone,
    (nd.date + interval '1 day')::timestamp with time zone,
    jsonb_build_object('migrated_from', 'nutrition_daily'),
    true
  FROM fitness.nutrition_daily nd
  WHERE NOT EXISTS (
    SELECT 1
    FROM fitness.food_entry fe
    WHERE fe.user_id = nd.user_id
      AND fe.provider_id = nd.provider_id
      AND fe.date = nd.date
  )
  ON CONFLICT (user_id, provider_id, external_id) DO NOTHING
  RETURNING id, user_id, provider_id, date
)
INSERT INTO fitness.food_entry_nutrition (
  food_entry_id,
  calories,
  protein_g,
  carbs_g,
  fat_g,
  saturated_fat_g,
  polyunsaturated_fat_g,
  monounsaturated_fat_g,
  trans_fat_g,
  cholesterol_mg,
  sodium_mg,
  potassium_mg,
  fiber_g,
  sugar_g,
  vitamin_a_mcg,
  vitamin_c_mg,
  vitamin_d_mcg,
  vitamin_e_mg,
  vitamin_k_mcg,
  vitamin_b1_mg,
  vitamin_b2_mg,
  vitamin_b3_mg,
  vitamin_b5_mg,
  vitamin_b6_mg,
  vitamin_b7_mcg,
  vitamin_b9_mcg,
  vitamin_b12_mcg,
  calcium_mg,
  iron_mg,
  magnesium_mg,
  zinc_mg,
  selenium_mcg,
  copper_mg,
  manganese_mg,
  chromium_mcg,
  iodine_mcg,
  omega3_mg,
  omega6_mg,
  water_ml
)
SELECT
  me.id,
  nd.calories,
  nd.protein_g,
  nd.carbs_g,
  nd.fat_g,
  nd.saturated_fat_g,
  nd.polyunsaturated_fat_g,
  nd.monounsaturated_fat_g,
  nd.trans_fat_g,
  nd.cholesterol_mg,
  nd.sodium_mg,
  nd.potassium_mg,
  nd.fiber_g,
  nd.sugar_g,
  nd.vitamin_a_mcg,
  nd.vitamin_c_mg,
  nd.vitamin_d_mcg,
  nd.vitamin_e_mg,
  nd.vitamin_k_mcg,
  nd.vitamin_b1_mg,
  nd.vitamin_b2_mg,
  nd.vitamin_b3_mg,
  nd.vitamin_b5_mg,
  nd.vitamin_b6_mg,
  nd.vitamin_b7_mcg,
  nd.vitamin_b9_mcg,
  nd.vitamin_b12_mcg,
  nd.calcium_mg,
  nd.iron_mg,
  nd.magnesium_mg,
  nd.zinc_mg,
  nd.selenium_mcg,
  nd.copper_mg,
  nd.manganese_mg,
  nd.chromium_mcg,
  nd.iodine_mcg,
  nd.omega3_mg,
  nd.omega6_mg,
  nd.water_ml
FROM migrated_entries me
JOIN fitness.nutrition_daily nd
  ON nd.user_id = me.user_id
 AND nd.provider_id = me.provider_id
 AND nd.date = me.date
ON CONFLICT (food_entry_id) DO NOTHING;
--> statement-breakpoint
DROP VIEW fitness.v_food_entry_with_nutrition;
--> statement-breakpoint
CREATE VIEW fitness.v_food_entry_with_nutrition AS
 SELECT fe.id,
    fe.provider_id,
    fe.user_id,
    fe.external_id,
    fe.date,
    fe.meal,
    fe.food_name,
    fe.food_description,
    fe.category,
    fe.provider_food_id,
    fe.provider_serving_id,
    fe.number_of_units,
    fe.logged_at,
    fe.source_name,
    fe.started_at,
    fe.ended_at,
    fe.barcode,
    fe.serving_unit,
    fe.serving_weight_grams,
    fen.id AS nutrition_data_id,
    fen.calories,
    fen.protein_g,
    fen.carbs_g,
    fen.fat_g,
    fen.saturated_fat_g,
    fen.polyunsaturated_fat_g,
    fen.monounsaturated_fat_g,
    fen.trans_fat_g,
    fen.cholesterol_mg,
    fen.sodium_mg,
    fen.potassium_mg,
    fen.fiber_g,
    fen.sugar_g,
    fen.vitamin_a_mcg,
    fen.vitamin_c_mg,
    fen.vitamin_d_mcg,
    fen.vitamin_e_mg,
    fen.vitamin_k_mcg,
    fen.vitamin_b1_mg,
    fen.vitamin_b2_mg,
    fen.vitamin_b3_mg,
    fen.vitamin_b5_mg,
    fen.vitamin_b6_mg,
    fen.vitamin_b7_mcg,
    fen.vitamin_b9_mcg,
    fen.vitamin_b12_mcg,
    fen.calcium_mg,
    fen.iron_mg,
    fen.magnesium_mg,
    fen.zinc_mg,
    fen.selenium_mcg,
    fen.copper_mg,
    fen.manganese_mg,
    fen.chromium_mcg,
    fen.iodine_mcg,
    fen.omega3_mg,
    fen.omega6_mg,
    fen.water_ml,
    fe.raw,
    fe.confirmed,
    fe.created_at
   FROM fitness.food_entry fe
     LEFT JOIN fitness.food_entry_nutrition fen ON fen.food_entry_id = fe.id;
--> statement-breakpoint
CREATE OR REPLACE VIEW fitness.v_nutrition_daily AS
 SELECT fe.date,
    fe.provider_id,
    fe.user_id,
    SUM(fen.calories)::integer AS calories,
    SUM(fen.protein_g) AS protein_g,
    SUM(fen.carbs_g) AS carbs_g,
    SUM(fen.fat_g) AS fat_g,
    SUM(fen.saturated_fat_g) AS saturated_fat_g,
    SUM(fen.polyunsaturated_fat_g) AS polyunsaturated_fat_g,
    SUM(fen.monounsaturated_fat_g) AS monounsaturated_fat_g,
    SUM(fen.trans_fat_g) AS trans_fat_g,
    SUM(fen.cholesterol_mg) AS cholesterol_mg,
    SUM(fen.sodium_mg) AS sodium_mg,
    SUM(fen.potassium_mg) AS potassium_mg,
    SUM(fen.fiber_g) AS fiber_g,
    SUM(fen.sugar_g) AS sugar_g,
    SUM(fen.vitamin_a_mcg) AS vitamin_a_mcg,
    SUM(fen.vitamin_c_mg) AS vitamin_c_mg,
    SUM(fen.vitamin_d_mcg) AS vitamin_d_mcg,
    SUM(fen.vitamin_e_mg) AS vitamin_e_mg,
    SUM(fen.vitamin_k_mcg) AS vitamin_k_mcg,
    SUM(fen.vitamin_b1_mg) AS vitamin_b1_mg,
    SUM(fen.vitamin_b2_mg) AS vitamin_b2_mg,
    SUM(fen.vitamin_b3_mg) AS vitamin_b3_mg,
    SUM(fen.vitamin_b5_mg) AS vitamin_b5_mg,
    SUM(fen.vitamin_b6_mg) AS vitamin_b6_mg,
    SUM(fen.vitamin_b7_mcg) AS vitamin_b7_mcg,
    SUM(fen.vitamin_b9_mcg) AS vitamin_b9_mcg,
    SUM(fen.vitamin_b12_mcg) AS vitamin_b12_mcg,
    SUM(fen.calcium_mg) AS calcium_mg,
    SUM(fen.iron_mg) AS iron_mg,
    SUM(fen.magnesium_mg) AS magnesium_mg,
    SUM(fen.zinc_mg) AS zinc_mg,
    SUM(fen.selenium_mcg) AS selenium_mcg,
    SUM(fen.copper_mg) AS copper_mg,
    SUM(fen.manganese_mg) AS manganese_mg,
    SUM(fen.chromium_mcg) AS chromium_mcg,
    SUM(fen.iodine_mcg) AS iodine_mcg,
    SUM(fen.omega3_mg) AS omega3_mg,
    SUM(fen.omega6_mg) AS omega6_mg,
    SUM(fen.water_ml)::integer AS water_ml,
    MIN(fe.created_at) AS created_at
   FROM fitness.food_entry fe
     JOIN fitness.food_entry_nutrition fen ON fen.food_entry_id = fe.id
  WHERE fe.confirmed = true
  GROUP BY fe.date, fe.provider_id, fe.user_id;
