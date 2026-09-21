ALTER TABLE fitness.food_entry ADD COLUMN source_account_key text;
--> statement-breakpoint
ALTER TYPE fitness.nutrition_entry_grain ADD VALUE IF NOT EXISTS 'meal_aggregate' BEFORE 'daily_aggregate';
--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_food_entry_effective AS
SELECT
  identity.id AS record_id,
  source.id AS source_entry_id,
  source.user_id,
  source.provider_id,
  source.external_id,
  CASE
    WHEN date_decision.operation = 'set' THEN (date_decision.value #>> '{}')::date
    ELSE source.date
  END AS date,
  CASE
    WHEN meal_decision.operation = 'set' THEN (meal_decision.value #>> '{}')::fitness.meal
    ELSE source.meal
  END AS meal,
  CASE
    WHEN food_name_decision.operation = 'set' THEN food_name_decision.value #>> '{}'
    ELSE source.food_name
  END AS food_name,
  CASE
    WHEN food_description_decision.operation = 'set' THEN food_description_decision.value #>> '{}'
    ELSE source.food_description
  END AS food_description,
  CASE
    WHEN category_decision.operation = 'set'
      THEN (category_decision.value #>> '{}')::fitness.food_category
    ELSE source.category
  END AS category,
  CASE
    WHEN number_of_units_decision.operation = 'set'
      THEN (number_of_units_decision.value #>> '{}')::real
    ELSE source.number_of_units
  END AS number_of_units,
  CASE
    WHEN serving_unit_decision.operation = 'set' THEN serving_unit_decision.value #>> '{}'
    ELSE source.serving_unit
  END AS serving_unit,
  CASE
    WHEN serving_weight_decision.operation = 'set'
      THEN (serving_weight_decision.value #>> '{}')::real
    ELSE source.serving_weight_grams
  END AS serving_weight_grams,
  COALESCE(visibility.deleted, FALSE) AS deleted,
  head.target_id AS version,
  identity.id IS NOT NULL AND NULLIF(BTRIM(source.external_id), '') IS NOT NULL AS modifiable,
  CASE
    WHEN identity.id IS NULL THEN 'A stable identity has not been assigned to this food entry.'
    WHEN NULLIF(BTRIM(source.external_id), '') IS NULL
      THEN 'This food entry has no stable provider external ID and cannot be modified safely.'
  END AS modification_unavailable_reason,
  source.date AS source_date,
  source.meal AS source_meal,
  source.food_name AS source_food_name,
  source.food_description AS source_food_description,
  source.category AS source_category,
  source.number_of_units AS source_number_of_units,
  source.serving_unit AS source_serving_unit,
  source.serving_weight_grams AS source_serving_weight_grams,
  date_decision.change_id AS date_change_id,
  meal_decision.change_id AS meal_change_id,
  food_name_decision.change_id AS food_name_change_id,
  food_description_decision.change_id AS food_description_change_id,
  category_decision.change_id AS category_change_id,
  number_of_units_decision.change_id AS number_of_units_change_id,
  serving_unit_decision.change_id AS serving_unit_change_id,
  serving_weight_decision.change_id AS serving_weight_grams_change_id,
  source.nutrition_grain,
  source.provider_food_id,
  source.provider_serving_id,
  source.logged_at,
  source.source_name,
  source.started_at,
  source.ended_at,
  source.barcode,
  source.raw,
  source.confirmed,
  source.created_at,
  source.source_account_key
FROM fitness.food_entry AS source
LEFT JOIN fitness.human_record_identity AS identity
  ON
    source.user_id = identity.user_id
    AND identity.domain = 'nutrition.food'
    AND source.provider_id = identity.namespace
    AND identity.source_key = CASE
      WHEN NULLIF(BTRIM(source.external_id), '') IS NOT NULL
        THEN 'external:' || source.external_id
      ELSE 'row:' || source.id::text
    END
LEFT JOIN fitness.v_human_record_head AS head
  ON identity.user_id = head.user_id AND identity.id = head.identity_id
LEFT JOIN fitness.v_human_record_visibility AS visibility
  ON identity.user_id = visibility.user_id AND identity.id = visibility.identity_id
LEFT JOIN fitness.v_human_record_field AS date_decision
  ON
    identity.user_id = date_decision.user_id
    AND identity.id = date_decision.identity_id
    AND date_decision.field = 'date'
LEFT JOIN fitness.v_human_record_field AS meal_decision
  ON
    identity.user_id = meal_decision.user_id
    AND identity.id = meal_decision.identity_id
    AND meal_decision.field = 'meal'
LEFT JOIN fitness.v_human_record_field AS food_name_decision
  ON
    identity.user_id = food_name_decision.user_id
    AND identity.id = food_name_decision.identity_id
    AND food_name_decision.field = 'food_name'
LEFT JOIN fitness.v_human_record_field AS food_description_decision
  ON
    identity.user_id = food_description_decision.user_id
    AND identity.id = food_description_decision.identity_id
    AND food_description_decision.field = 'food_description'
LEFT JOIN fitness.v_human_record_field AS category_decision
  ON
    identity.user_id = category_decision.user_id
    AND identity.id = category_decision.identity_id
    AND category_decision.field = 'category'
LEFT JOIN fitness.v_human_record_field AS number_of_units_decision
  ON
    identity.user_id = number_of_units_decision.user_id
    AND identity.id = number_of_units_decision.identity_id
    AND number_of_units_decision.field = 'number_of_units'
LEFT JOIN fitness.v_human_record_field AS serving_unit_decision
  ON
    identity.user_id = serving_unit_decision.user_id
    AND identity.id = serving_unit_decision.identity_id
    AND serving_unit_decision.field = 'serving_unit'
LEFT JOIN fitness.v_human_record_field AS serving_weight_decision
  ON
    identity.user_id = serving_weight_decision.user_id
    AND identity.id = serving_weight_decision.identity_id
    AND serving_weight_decision.field = 'serving_weight_grams';
--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_nutrition_entry_classification AS
WITH nutrient_counts AS (
  SELECT
    source_entry_id AS food_entry_id,
    COUNT(*)::integer AS nutrient_count
  FROM fitness.v_food_entry_effective_nutrient
  WHERE amount IS NOT NULL
  GROUP BY source_entry_id
)

SELECT
  food.source_entry_id AS id,
  food.provider_id,
  food.user_id,
  food.date,
  food.nutrition_grain,
  food.meal,
  food.food_name,
  food.provider_food_id,
  food.provider_serving_id,
  food.source_name,
  food.confirmed,
  food.created_at,
  COALESCE(nutrient_counts.nutrient_count, 0) AS nutrient_count,
  COALESCE(
    food.nutrition_grain::text,
    CASE
      WHEN
        NULLIF(BTRIM(food.food_name), '') IS NOT NULL
        OR food.meal IS NOT NULL
        OR food.provider_food_id IS NOT NULL
        OR food.provider_serving_id IS NOT NULL
        THEN 'itemized'
      WHEN COALESCE(nutrient_counts.nutrient_count, 0) = 1
        THEN 'daily_aggregate'
      ELSE 'ambiguous'
    END
  ) AS effective_grain,
  CASE
    WHEN NULLIF(BTRIM(food.source_account_key), '') IS NOT NULL
      THEN food.provider_id || ':account:' || BTRIM(food.source_account_key)
    WHEN
      NULLIF(BTRIM(food.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(food.source_name)) <> LOWER(provider.name)
      THEN food.provider_id || ':source-name:' || BTRIM(food.source_name)
    ELSE food.provider_id || ':provider'
  END AS source_key,
  CASE
    WHEN
      NULLIF(BTRIM(food.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(food.source_name)) <> LOWER(COALESCE(provider.name, food.provider_id))
      THEN BTRIM(food.source_name) || ' (via ' || provider.name || ')'
    ELSE provider.name
  END AS source_label
FROM fitness.v_food_entry_effective AS food
INNER JOIN fitness.provider AS provider ON food.provider_id = provider.id
LEFT JOIN nutrient_counts ON food.source_entry_id = nutrient_counts.food_entry_id
WHERE food.deleted = FALSE;
--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_nutrition_daily_resolution AS
WITH confirmed AS (
  SELECT *
  FROM fitness.v_nutrition_entry_classification
  WHERE confirmed = TRUE
),

grouped AS (
  SELECT
    user_id,
    date,
    ARRAY_AGG(DISTINCT provider_id ORDER BY provider_id) AS source_providers,
    ARRAY_AGG(DISTINCT source_key ORDER BY source_key) AS source_keys,
    COUNT(DISTINCT source_key) FILTER (WHERE effective_grain = 'itemized')::integer
      AS itemized_source_count,
    COUNT(DISTINCT source_key) FILTER (WHERE effective_grain = 'meal_aggregate')::integer
      AS meal_aggregate_source_count,
    COUNT(DISTINCT source_key) FILTER (WHERE effective_grain = 'daily_aggregate')::integer
      AS aggregate_source_count,
    COUNT(DISTINCT source_key) FILTER (WHERE effective_grain = 'ambiguous')::integer
      AS ambiguous_source_count,
    COUNT(*) FILTER (WHERE effective_grain = 'ambiguous')::integer AS ambiguous_entry_count,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'itemized'),
      ARRAY[]::text[]
    ) AS itemized_source_keys,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'meal_aggregate'),
      ARRAY[]::text[]
    ) AS meal_aggregate_source_keys,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'daily_aggregate'),
      ARRAY[]::text[]
    ) AS aggregate_source_keys,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'ambiguous'),
      ARRAY[]::text[]
    ) AS ambiguous_source_keys
  FROM confirmed
  GROUP BY user_id, date
),

decisions AS (
  SELECT
    grouped.*,
    CASE
      WHEN
        grouped.ambiguous_source_count > 0
        AND NOT (
          grouped.itemized_source_count = 0
          AND grouped.meal_aggregate_source_count = 0
          AND grouped.aggregate_source_count = 0
          AND grouped.ambiguous_source_count = 1
          AND grouped.ambiguous_entry_count = 1
        )
        THEN 'source_conflict'
      WHEN grouped.itemized_source_count > 1 THEN 'source_conflict'
      WHEN grouped.itemized_source_count = 1 THEN 'available'
      WHEN grouped.meal_aggregate_source_count > 1 THEN 'source_conflict'
      WHEN grouped.meal_aggregate_source_count = 1 THEN 'available'
      WHEN grouped.aggregate_source_count > 1 THEN 'source_conflict'
      WHEN grouped.aggregate_source_count = 1 THEN 'available'
      WHEN grouped.ambiguous_source_count = 1 AND grouped.ambiguous_entry_count = 1 THEN 'available'
      ELSE 'source_conflict'
    END AS resolution_status,
    CASE
      WHEN
        grouped.ambiguous_source_count > 0
        AND NOT (
          grouped.itemized_source_count = 0
          AND grouped.meal_aggregate_source_count = 0
          AND grouped.aggregate_source_count = 0
          AND grouped.ambiguous_source_count = 1
          AND grouped.ambiguous_entry_count = 1
        )
        THEN ARRAY[]::text[]
      WHEN grouped.itemized_source_count > 1 THEN ARRAY[]::text[]
      WHEN grouped.itemized_source_count = 1 THEN grouped.itemized_source_keys
      WHEN grouped.meal_aggregate_source_count > 1 THEN ARRAY[]::text[]
      WHEN grouped.meal_aggregate_source_count = 1 THEN grouped.meal_aggregate_source_keys
      WHEN grouped.aggregate_source_count > 1 THEN ARRAY[]::text[]
      WHEN grouped.aggregate_source_count = 1 THEN grouped.aggregate_source_keys
      WHEN grouped.ambiguous_source_count = 1 AND grouped.ambiguous_entry_count = 1
        THEN grouped.ambiguous_source_keys
      ELSE ARRAY[]::text[]
    END AS contributing_source_keys,
    CASE
      WHEN grouped.itemized_source_count = 1 AND grouped.ambiguous_source_count = 0
        THEN 'itemized'
      WHEN
        grouped.itemized_source_count = 0
        AND grouped.meal_aggregate_source_count = 1
        AND grouped.ambiguous_source_count = 0
        THEN 'meal_aggregate'
      WHEN
        grouped.itemized_source_count = 0
        AND grouped.meal_aggregate_source_count = 0
        AND grouped.aggregate_source_count = 1
        AND grouped.ambiguous_source_count = 0
        THEN 'daily_aggregate'
      WHEN
        grouped.itemized_source_count = 0
        AND grouped.meal_aggregate_source_count = 0
        AND grouped.aggregate_source_count = 0
        AND grouped.ambiguous_source_count = 1
        AND grouped.ambiguous_entry_count = 1
        THEN 'ambiguous'
    END AS contribution_grain
  FROM grouped
)

SELECT
  decisions.user_id,
  decisions.date,
  decisions.resolution_status,
  CASE
    WHEN decisions.resolution_status = 'source_conflict'
      THEN 'Totals are unavailable because nutrition sources overlap and no canonical contribution set can be determined.'
    WHEN CARDINALITY(decisions.source_keys) > CARDINALITY(decisions.contributing_source_keys)
      THEN 'Totals use the most detailed available source; overlapping less detailed sources are preserved but excluded.'
    ELSE 'Totals use the only available nutrition source.'
  END AS resolution_message,
  decisions.source_providers,
  ARRAY(
    SELECT DISTINCT confirmed.provider_id
    FROM confirmed
    WHERE
      confirmed.user_id = decisions.user_id
      AND confirmed.date = decisions.date
      AND confirmed.source_key = ANY(decisions.contributing_source_keys)
    ORDER BY confirmed.provider_id
  ) AS contributing_providers,
  ARRAY(
    SELECT DISTINCT confirmed.provider_id
    FROM confirmed
    WHERE
      confirmed.user_id = decisions.user_id
      AND confirmed.date = decisions.date
      AND NOT (confirmed.source_key = ANY(decisions.contributing_source_keys))
    ORDER BY confirmed.provider_id
  ) AS excluded_providers,
  ARRAY(
    SELECT DISTINCT confirmed.source_label
    FROM confirmed
    WHERE confirmed.user_id = decisions.user_id AND confirmed.date = decisions.date
    ORDER BY confirmed.source_label
  ) AS source_labels,
  ARRAY(
    SELECT DISTINCT confirmed.source_label
    FROM confirmed
    WHERE
      confirmed.user_id = decisions.user_id
      AND confirmed.date = decisions.date
      AND confirmed.source_key = ANY(decisions.contributing_source_keys)
    ORDER BY confirmed.source_label
  ) AS contributing_source_labels,
  ARRAY(
    SELECT DISTINCT confirmed.source_label
    FROM confirmed
    WHERE
      confirmed.user_id = decisions.user_id
      AND confirmed.date = decisions.date
      AND NOT (confirmed.source_key = ANY(decisions.contributing_source_keys))
    ORDER BY confirmed.source_label
  ) AS excluded_source_labels,
  decisions.contributing_source_keys,
  decisions.contribution_grain
FROM decisions;
--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_nutrition_display_entry AS
SELECT
  entry.id,
  entry.provider_id,
  entry.user_id,
  entry.external_id,
  entry.date,
  entry.meal,
  entry.food_name,
  entry.food_description,
  entry.category,
  entry.provider_food_id,
  entry.provider_serving_id,
  entry.number_of_units,
  entry.logged_at,
  entry.source_name,
  entry.started_at,
  entry.ended_at,
  entry.barcode,
  entry.serving_unit,
  entry.serving_weight_grams,
  entry.nutrition_data_id,
  entry.calories,
  entry.protein_g,
  entry.carbs_g,
  entry.fat_g,
  entry.saturated_fat_g,
  entry.polyunsaturated_fat_g,
  entry.monounsaturated_fat_g,
  entry.trans_fat_g,
  entry.cholesterol_mg,
  entry.sodium_mg,
  entry.potassium_mg,
  entry.fiber_g,
  entry.sugar_g,
  entry.vitamin_a_mcg,
  entry.vitamin_c_mg,
  entry.vitamin_d_mcg,
  entry.vitamin_e_mg,
  entry.vitamin_k_mcg,
  entry.vitamin_b1_mg,
  entry.vitamin_b2_mg,
  entry.vitamin_b3_mg,
  entry.vitamin_b5_mg,
  entry.vitamin_b6_mg,
  entry.vitamin_b7_mcg,
  entry.vitamin_b9_mcg,
  entry.vitamin_b12_mcg,
  entry.calcium_mg,
  entry.iron_mg,
  entry.magnesium_mg,
  entry.zinc_mg,
  entry.selenium_mcg,
  entry.copper_mg,
  entry.manganese_mg,
  entry.chromium_mcg,
  entry.iodine_mcg,
  entry.omega3_mg,
  entry.omega6_mg,
  entry.caffeine_mg,
  entry.water_ml,
  entry.raw,
  entry.confirmed,
  entry.created_at
FROM fitness.v_food_entry_with_nutrition AS entry
INNER JOIN fitness.v_nutrition_entry_classification AS classification
  ON entry.id = classification.id
WHERE classification.effective_grain IN ('itemized', 'meal_aggregate');
