-- Canonicalize nutrient storage on fitness.nutrient + amount rows.

INSERT INTO fitness.nutrient (id, display_name, unit, category, rda, sort_order, open_food_facts_key, conversion_factor)
VALUES
  ('calories', 'Calories', 'kcal', 'macro', NULL, 1, 'energy-kcal', 1),
  ('protein', 'Protein', 'g', 'macro', NULL, 2, 'proteins', 1),
  ('carbohydrate', 'Carbohydrates', 'g', 'macro', NULL, 3, 'carbohydrates', 1),
  ('fat', 'Fat', 'g', 'macro', NULL, 4, 'fat', 1),
  ('fiber', 'Fiber', 'g', 'macro', 38, 5, 'fiber', 1),
  ('saturated_fat', 'Saturated Fat', 'g', 'fat_breakdown', NULL, 100, 'saturated-fat', 1),
  ('polyunsaturated_fat', 'Polyunsaturated Fat', 'g', 'fat_breakdown', NULL, 101, 'polyunsaturated-fat', 1),
  ('monounsaturated_fat', 'Monounsaturated Fat', 'g', 'fat_breakdown', NULL, 102, 'monounsaturated-fat', 1),
  ('trans_fat', 'Trans Fat', 'g', 'fat_breakdown', NULL, 103, 'trans-fat', 1),
  ('cholesterol', 'Cholesterol', 'mg', 'other_macro', NULL, 200, 'cholesterol', 1),
  ('sodium', 'Sodium', 'mg', 'other_macro', 2300, 201, 'sodium', 1000),
  ('potassium', 'Potassium', 'mg', 'other_macro', 3400, 202, 'potassium', 1),
  ('sugar', 'Sugar', 'g', 'other_macro', NULL, 203, 'sugars', 1),
  ('vitamin_a', 'Vitamin A', 'mcg', 'vitamin', 900, 300, 'vitamin-a', 1),
  ('vitamin_c', 'Vitamin C', 'mg', 'vitamin', 90, 301, 'vitamin-c', 1),
  ('vitamin_d', 'Vitamin D', 'mcg', 'vitamin', 15, 302, 'vitamin-d', 1),
  ('vitamin_e', 'Vitamin E', 'mg', 'vitamin', 15, 303, 'vitamin-e', 1),
  ('vitamin_k', 'Vitamin K', 'mcg', 'vitamin', 120, 304, 'vitamin-k', 1),
  ('vitamin_b1', 'Vitamin B1 (Thiamin)', 'mg', 'vitamin', 1.2, 305, 'vitamin-b1', 1),
  ('vitamin_b2', 'Vitamin B2 (Riboflavin)', 'mg', 'vitamin', 1.3, 306, 'vitamin-b2', 1),
  ('vitamin_b3', 'Vitamin B3 (Niacin)', 'mg', 'vitamin', 16, 307, 'vitamin-pp', 1),
  ('vitamin_b5', 'Vitamin B5 (Pantothenic Acid)', 'mg', 'vitamin', 5, 308, 'pantothenic-acid', 1),
  ('vitamin_b6', 'Vitamin B6', 'mg', 'vitamin', 1.3, 309, 'vitamin-b6', 1),
  ('vitamin_b7', 'Vitamin B7 (Biotin)', 'mcg', 'vitamin', 30, 310, 'biotin', 1),
  ('vitamin_b9', 'Vitamin B9 (Folate)', 'mcg', 'vitamin', 400, 311, 'vitamin-b9', 1),
  ('vitamin_b12', 'Vitamin B12', 'mcg', 'vitamin', 2.4, 312, 'vitamin-b12', 1),
  ('calcium', 'Calcium', 'mg', 'mineral', 1000, 400, 'calcium', 1),
  ('iron', 'Iron', 'mg', 'mineral', 8, 401, 'iron', 1),
  ('magnesium', 'Magnesium', 'mg', 'mineral', 420, 402, 'magnesium', 1),
  ('zinc', 'Zinc', 'mg', 'mineral', 11, 403, 'zinc', 1),
  ('selenium', 'Selenium', 'mcg', 'mineral', 55, 404, 'selenium', 1),
  ('copper', 'Copper', 'mg', 'mineral', 0.9, 405, 'copper', 1),
  ('manganese', 'Manganese', 'mg', 'mineral', 2.3, 406, 'manganese', 1),
  ('chromium', 'Chromium', 'mcg', 'mineral', 35, 407, 'chromium', 1),
  ('iodine', 'Iodine', 'mcg', 'mineral', 150, 408, 'iodine', 1),
  ('phosphorus', 'Phosphorus', 'mg', 'mineral', 700, 409, 'phosphorus', 1),
  ('molybdenum', 'Molybdenum', 'mcg', 'mineral', 45, 410, 'molybdenum', 1),
  ('chloride', 'Chloride', 'mg', 'mineral', 2300, 411, 'chloride', 1),
  ('fluoride', 'Fluoride', 'mg', 'mineral', 4, 412, 'fluoride', 1),
  ('choline', 'Choline', 'mg', 'mineral', 550, 413, 'choline', 1),
  ('omega_3', 'Omega-3', 'mg', 'fatty_acid', NULL, 500, 'omega-3-fat', 1000),
  ('omega_6', 'Omega-6', 'mg', 'fatty_acid', NULL, 501, 'omega-6-fat', 1000),
  ('caffeine', 'Caffeine', 'mg', 'stimulant', NULL, 600, 'caffeine', 1)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  unit = EXCLUDED.unit,
  category = EXCLUDED.category,
  rda = EXCLUDED.rda,
  sort_order = EXCLUDED.sort_order,
  open_food_facts_key = EXCLUDED.open_food_facts_key,
  conversion_factor = EXCLUDED.conversion_factor;

ALTER TABLE ONLY fitness.nutrition_daily
  DROP CONSTRAINT IF EXISTS nutrition_daily_date_provider_id_pk;

DROP INDEX IF EXISTS fitness.nutrition_daily_user_date_provider_uidx;

ALTER TABLE ONLY fitness.nutrition_daily
  ADD CONSTRAINT nutrition_daily_user_date_provider_pk PRIMARY KEY (user_id, date, provider_id);

CREATE TABLE fitness.nutrition_daily_nutrient (
  user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
  date date NOT NULL,
  provider_id text NOT NULL REFERENCES fitness.provider(id),
  nutrient_id text NOT NULL REFERENCES fitness.nutrient(id),
  amount real NOT NULL,
  PRIMARY KEY (user_id, date, provider_id, nutrient_id),
  FOREIGN KEY (user_id, date, provider_id)
    REFERENCES fitness.nutrition_daily(user_id, date, provider_id)
    ON DELETE CASCADE
);

CREATE INDEX nutrition_daily_nutrient_lookup_idx
  ON fitness.nutrition_daily_nutrient (user_id, date, provider_id);

INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
SELECT fen.food_entry_id, nutrient_values.nutrient_id, nutrient_values.amount
FROM fitness.food_entry_nutrition fen
CROSS JOIN LATERAL (
  VALUES
    ('calories', fen.calories::real),
    ('protein', fen.protein_g),
    ('carbohydrate', fen.carbs_g),
    ('fat', fen.fat_g),
    ('saturated_fat', fen.saturated_fat_g),
    ('polyunsaturated_fat', fen.polyunsaturated_fat_g),
    ('monounsaturated_fat', fen.monounsaturated_fat_g),
    ('trans_fat', fen.trans_fat_g),
    ('cholesterol', fen.cholesterol_mg),
    ('sodium', fen.sodium_mg),
    ('potassium', fen.potassium_mg),
    ('fiber', fen.fiber_g),
    ('sugar', fen.sugar_g),
    ('vitamin_a', fen.vitamin_a_mcg),
    ('vitamin_c', fen.vitamin_c_mg),
    ('vitamin_d', fen.vitamin_d_mcg),
    ('vitamin_e', fen.vitamin_e_mg),
    ('vitamin_k', fen.vitamin_k_mcg),
    ('vitamin_b1', fen.vitamin_b1_mg),
    ('vitamin_b2', fen.vitamin_b2_mg),
    ('vitamin_b3', fen.vitamin_b3_mg),
    ('vitamin_b5', fen.vitamin_b5_mg),
    ('vitamin_b6', fen.vitamin_b6_mg),
    ('vitamin_b7', fen.vitamin_b7_mcg),
    ('vitamin_b9', fen.vitamin_b9_mcg),
    ('vitamin_b12', fen.vitamin_b12_mcg),
    ('calcium', fen.calcium_mg),
    ('iron', fen.iron_mg),
    ('magnesium', fen.magnesium_mg),
    ('zinc', fen.zinc_mg),
    ('selenium', fen.selenium_mcg),
    ('copper', fen.copper_mg),
    ('manganese', fen.manganese_mg),
    ('chromium', fen.chromium_mcg),
    ('iodine', fen.iodine_mcg),
    ('omega_3', fen.omega3_mg),
    ('omega_6', fen.omega6_mg)
) AS nutrient_values(nutrient_id, amount)
WHERE nutrient_values.amount IS NOT NULL
ON CONFLICT (food_entry_id, nutrient_id) DO UPDATE SET amount = EXCLUDED.amount;

INSERT INTO fitness.supplement_nutrient (supplement_id, nutrient_id, amount)
SELECT sn.supplement_id, nutrient_values.nutrient_id, nutrient_values.amount
FROM fitness.supplement_nutrition sn
CROSS JOIN LATERAL (
  VALUES
    ('calories', sn.calories::real),
    ('protein', sn.protein_g),
    ('carbohydrate', sn.carbs_g),
    ('fat', sn.fat_g),
    ('saturated_fat', sn.saturated_fat_g),
    ('polyunsaturated_fat', sn.polyunsaturated_fat_g),
    ('monounsaturated_fat', sn.monounsaturated_fat_g),
    ('trans_fat', sn.trans_fat_g),
    ('cholesterol', sn.cholesterol_mg),
    ('sodium', sn.sodium_mg),
    ('potassium', sn.potassium_mg),
    ('fiber', sn.fiber_g),
    ('sugar', sn.sugar_g),
    ('vitamin_a', sn.vitamin_a_mcg),
    ('vitamin_c', sn.vitamin_c_mg),
    ('vitamin_d', sn.vitamin_d_mcg),
    ('vitamin_e', sn.vitamin_e_mg),
    ('vitamin_k', sn.vitamin_k_mcg),
    ('vitamin_b1', sn.vitamin_b1_mg),
    ('vitamin_b2', sn.vitamin_b2_mg),
    ('vitamin_b3', sn.vitamin_b3_mg),
    ('vitamin_b5', sn.vitamin_b5_mg),
    ('vitamin_b6', sn.vitamin_b6_mg),
    ('vitamin_b7', sn.vitamin_b7_mcg),
    ('vitamin_b9', sn.vitamin_b9_mcg),
    ('vitamin_b12', sn.vitamin_b12_mcg),
    ('calcium', sn.calcium_mg),
    ('iron', sn.iron_mg),
    ('magnesium', sn.magnesium_mg),
    ('zinc', sn.zinc_mg),
    ('selenium', sn.selenium_mcg),
    ('copper', sn.copper_mg),
    ('manganese', sn.manganese_mg),
    ('chromium', sn.chromium_mcg),
    ('iodine', sn.iodine_mcg),
    ('omega_3', sn.omega3_mg),
    ('omega_6', sn.omega6_mg)
) AS nutrient_values(nutrient_id, amount)
WHERE nutrient_values.amount IS NOT NULL
ON CONFLICT (supplement_id, nutrient_id) DO UPDATE SET amount = EXCLUDED.amount;

INSERT INTO fitness.nutrition_daily_nutrient (user_id, date, provider_id, nutrient_id, amount)
SELECT nd.user_id, nd.date, nd.provider_id, nutrient_values.nutrient_id, nutrient_values.amount
FROM fitness.nutrition_daily nd
CROSS JOIN LATERAL (
  VALUES
    ('calories', nd.calories::real),
    ('protein', nd.protein_g),
    ('carbohydrate', nd.carbs_g),
    ('fat', nd.fat_g),
    ('saturated_fat', nd.saturated_fat_g),
    ('polyunsaturated_fat', nd.polyunsaturated_fat_g),
    ('monounsaturated_fat', nd.monounsaturated_fat_g),
    ('trans_fat', nd.trans_fat_g),
    ('cholesterol', nd.cholesterol_mg),
    ('sodium', nd.sodium_mg),
    ('potassium', nd.potassium_mg),
    ('fiber', nd.fiber_g),
    ('sugar', nd.sugar_g),
    ('vitamin_a', nd.vitamin_a_mcg),
    ('vitamin_c', nd.vitamin_c_mg),
    ('vitamin_d', nd.vitamin_d_mcg),
    ('vitamin_e', nd.vitamin_e_mg),
    ('vitamin_k', nd.vitamin_k_mcg),
    ('vitamin_b1', nd.vitamin_b1_mg),
    ('vitamin_b2', nd.vitamin_b2_mg),
    ('vitamin_b3', nd.vitamin_b3_mg),
    ('vitamin_b5', nd.vitamin_b5_mg),
    ('vitamin_b6', nd.vitamin_b6_mg),
    ('vitamin_b7', nd.vitamin_b7_mcg),
    ('vitamin_b9', nd.vitamin_b9_mcg),
    ('vitamin_b12', nd.vitamin_b12_mcg),
    ('calcium', nd.calcium_mg),
    ('iron', nd.iron_mg),
    ('magnesium', nd.magnesium_mg),
    ('zinc', nd.zinc_mg),
    ('selenium', nd.selenium_mcg),
    ('copper', nd.copper_mg),
    ('manganese', nd.manganese_mg),
    ('chromium', nd.chromium_mcg),
    ('iodine', nd.iodine_mcg),
    ('omega_3', nd.omega3_mg),
    ('omega_6', nd.omega6_mg)
) AS nutrient_values(nutrient_id, amount)
WHERE nutrient_values.amount IS NOT NULL
ON CONFLICT (user_id, date, provider_id, nutrient_id) DO UPDATE SET amount = EXCLUDED.amount;

DROP VIEW IF EXISTS fitness.v_food_entry_with_nutrition;
DROP VIEW IF EXISTS fitness.v_supplement_with_nutrition;

DROP TABLE fitness.food_entry_nutrition;
DROP TABLE fitness.supplement_nutrition;
DROP TABLE fitness.nutrition_data;

ALTER TABLE fitness.nutrition_daily
  DROP COLUMN calories,
  DROP COLUMN protein_g,
  DROP COLUMN carbs_g,
  DROP COLUMN fat_g,
  DROP COLUMN saturated_fat_g,
  DROP COLUMN polyunsaturated_fat_g,
  DROP COLUMN monounsaturated_fat_g,
  DROP COLUMN trans_fat_g,
  DROP COLUMN cholesterol_mg,
  DROP COLUMN sodium_mg,
  DROP COLUMN potassium_mg,
  DROP COLUMN fiber_g,
  DROP COLUMN sugar_g,
  DROP COLUMN vitamin_a_mcg,
  DROP COLUMN vitamin_c_mg,
  DROP COLUMN vitamin_d_mcg,
  DROP COLUMN vitamin_e_mg,
  DROP COLUMN vitamin_k_mcg,
  DROP COLUMN vitamin_b1_mg,
  DROP COLUMN vitamin_b2_mg,
  DROP COLUMN vitamin_b3_mg,
  DROP COLUMN vitamin_b5_mg,
  DROP COLUMN vitamin_b6_mg,
  DROP COLUMN vitamin_b7_mcg,
  DROP COLUMN vitamin_b9_mcg,
  DROP COLUMN vitamin_b12_mcg,
  DROP COLUMN calcium_mg,
  DROP COLUMN iron_mg,
  DROP COLUMN magnesium_mg,
  DROP COLUMN zinc_mg,
  DROP COLUMN selenium_mcg,
  DROP COLUMN copper_mg,
  DROP COLUMN manganese_mg,
  DROP COLUMN chromium_mcg,
  DROP COLUMN iodine_mcg,
  DROP COLUMN omega3_mg,
  DROP COLUMN omega6_mg;

CREATE VIEW fitness.v_food_entry_with_nutrition AS
SELECT
  fe.id,
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
  fe.barcode,
  fe.serving_unit,
  fe.serving_weight_grams,
  NULL::uuid AS nutrition_data_id,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'calories')::integer AS calories,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'protein') AS protein_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'carbohydrate') AS carbs_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'fat') AS fat_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'saturated_fat') AS saturated_fat_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'polyunsaturated_fat') AS polyunsaturated_fat_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'monounsaturated_fat') AS monounsaturated_fat_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'trans_fat') AS trans_fat_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'cholesterol') AS cholesterol_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'sodium') AS sodium_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'potassium') AS potassium_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'fiber') AS fiber_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'sugar') AS sugar_g,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_a') AS vitamin_a_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_c') AS vitamin_c_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_d') AS vitamin_d_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_e') AS vitamin_e_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_k') AS vitamin_k_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b1') AS vitamin_b1_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b2') AS vitamin_b2_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b3') AS vitamin_b3_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b5') AS vitamin_b5_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b6') AS vitamin_b6_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b7') AS vitamin_b7_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b9') AS vitamin_b9_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'vitamin_b12') AS vitamin_b12_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'calcium') AS calcium_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'iron') AS iron_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'magnesium') AS magnesium_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'zinc') AS zinc_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'selenium') AS selenium_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'copper') AS copper_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'manganese') AS manganese_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'chromium') AS chromium_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'iodine') AS iodine_mcg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'omega_3') AS omega3_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'omega_6') AS omega6_mg,
  MAX(fen.amount) FILTER (WHERE fen.nutrient_id = 'caffeine') AS caffeine_mg,
  fe.raw,
  fe.confirmed,
  fe.created_at
FROM fitness.food_entry fe
LEFT JOIN fitness.food_entry_nutrient fen ON fen.food_entry_id = fe.id
GROUP BY fe.id;

CREATE VIEW fitness.v_supplement_with_nutrition AS
SELECT
  s.id,
  s.user_id,
  s.name,
  s.amount,
  s.unit,
  s.form,
  s.description,
  s.meal,
  s.sort_order,
  NULL::uuid AS nutrition_data_id,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'calories')::integer AS calories,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'protein') AS protein_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'carbohydrate') AS carbs_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'fat') AS fat_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'saturated_fat') AS saturated_fat_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'polyunsaturated_fat') AS polyunsaturated_fat_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'monounsaturated_fat') AS monounsaturated_fat_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'trans_fat') AS trans_fat_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'cholesterol') AS cholesterol_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'sodium') AS sodium_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'potassium') AS potassium_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'fiber') AS fiber_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'sugar') AS sugar_g,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_a') AS vitamin_a_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_c') AS vitamin_c_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_d') AS vitamin_d_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_e') AS vitamin_e_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_k') AS vitamin_k_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b1') AS vitamin_b1_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b2') AS vitamin_b2_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b3') AS vitamin_b3_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b5') AS vitamin_b5_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b6') AS vitamin_b6_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b7') AS vitamin_b7_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b9') AS vitamin_b9_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'vitamin_b12') AS vitamin_b12_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'calcium') AS calcium_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'iron') AS iron_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'magnesium') AS magnesium_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'zinc') AS zinc_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'selenium') AS selenium_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'copper') AS copper_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'manganese') AS manganese_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'chromium') AS chromium_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'iodine') AS iodine_mcg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'omega_3') AS omega3_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'omega_6') AS omega6_mg,
  MAX(sn.amount) FILTER (WHERE sn.nutrient_id = 'caffeine') AS caffeine_mg,
  s.created_at,
  s.updated_at
FROM fitness.supplement s
LEFT JOIN fitness.supplement_nutrient sn ON sn.supplement_id = s.id
GROUP BY s.id;

CREATE VIEW fitness.v_nutrition_daily_with_nutrients AS
SELECT
  nd.date,
  nd.provider_id,
  nd.user_id,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'calories')::integer AS calories,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'protein') AS protein_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'carbohydrate') AS carbs_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'fat') AS fat_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'saturated_fat') AS saturated_fat_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'polyunsaturated_fat') AS polyunsaturated_fat_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'monounsaturated_fat') AS monounsaturated_fat_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'trans_fat') AS trans_fat_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'cholesterol') AS cholesterol_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'sodium') AS sodium_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'potassium') AS potassium_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'fiber') AS fiber_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'sugar') AS sugar_g,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_a') AS vitamin_a_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_c') AS vitamin_c_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_d') AS vitamin_d_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_e') AS vitamin_e_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_k') AS vitamin_k_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b1') AS vitamin_b1_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b2') AS vitamin_b2_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b3') AS vitamin_b3_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b5') AS vitamin_b5_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b6') AS vitamin_b6_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b7') AS vitamin_b7_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b9') AS vitamin_b9_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'vitamin_b12') AS vitamin_b12_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'calcium') AS calcium_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'iron') AS iron_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'magnesium') AS magnesium_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'zinc') AS zinc_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'selenium') AS selenium_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'copper') AS copper_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'manganese') AS manganese_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'chromium') AS chromium_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'iodine') AS iodine_mcg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'omega_3') AS omega3_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'omega_6') AS omega6_mg,
  MAX(ndn.amount) FILTER (WHERE ndn.nutrient_id = 'caffeine') AS caffeine_mg,
  nd.water_ml,
  nd.created_at
FROM fitness.nutrition_daily nd
LEFT JOIN fitness.nutrition_daily_nutrient ndn
  ON ndn.user_id = nd.user_id
  AND ndn.date = nd.date
  AND ndn.provider_id = nd.provider_id
GROUP BY nd.user_id, nd.date, nd.provider_id, nd.water_ml, nd.created_at;
