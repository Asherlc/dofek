DROP VIEW fitness.v_nutrition_display_entry;
--> statement-breakpoint
DROP VIEW fitness.v_nutrition_daily;
--> statement-breakpoint
DROP VIEW fitness.v_nutrition_canonical_nutrient;
--> statement-breakpoint
DROP VIEW fitness.v_nutrition_daily_resolution;
--> statement-breakpoint
DROP VIEW fitness.v_nutrition_entry_classification;
--> statement-breakpoint
DROP VIEW fitness.v_food_entry_with_nutrition;
--> statement-breakpoint

CREATE VIEW fitness.v_food_entry_effective AS
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
    ELSE NULL
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
  source.created_at
FROM fitness.food_entry AS source
LEFT JOIN fitness.human_record_identity AS identity
  ON
    identity.user_id = source.user_id
    AND identity.domain = 'nutrition.food'
    AND identity.namespace = source.provider_id
    AND identity.source_key = CASE
      WHEN NULLIF(BTRIM(source.external_id), '') IS NOT NULL
        THEN 'external:' || source.external_id
      ELSE 'row:' || source.id::text
    END
LEFT JOIN fitness.v_human_record_head AS head
  ON head.user_id = identity.user_id AND head.identity_id = identity.id
LEFT JOIN fitness.v_human_record_visibility AS visibility
  ON visibility.user_id = identity.user_id AND visibility.identity_id = identity.id
LEFT JOIN fitness.v_human_record_field AS date_decision
  ON
    date_decision.user_id = identity.user_id
    AND date_decision.identity_id = identity.id
    AND date_decision.field = 'date'
LEFT JOIN fitness.v_human_record_field AS meal_decision
  ON
    meal_decision.user_id = identity.user_id
    AND meal_decision.identity_id = identity.id
    AND meal_decision.field = 'meal'
LEFT JOIN fitness.v_human_record_field AS food_name_decision
  ON
    food_name_decision.user_id = identity.user_id
    AND food_name_decision.identity_id = identity.id
    AND food_name_decision.field = 'food_name'
LEFT JOIN fitness.v_human_record_field AS food_description_decision
  ON
    food_description_decision.user_id = identity.user_id
    AND food_description_decision.identity_id = identity.id
    AND food_description_decision.field = 'food_description'
LEFT JOIN fitness.v_human_record_field AS category_decision
  ON
    category_decision.user_id = identity.user_id
    AND category_decision.identity_id = identity.id
    AND category_decision.field = 'category'
LEFT JOIN fitness.v_human_record_field AS number_of_units_decision
  ON
    number_of_units_decision.user_id = identity.user_id
    AND number_of_units_decision.identity_id = identity.id
    AND number_of_units_decision.field = 'number_of_units'
LEFT JOIN fitness.v_human_record_field AS serving_unit_decision
  ON
    serving_unit_decision.user_id = identity.user_id
    AND serving_unit_decision.identity_id = identity.id
    AND serving_unit_decision.field = 'serving_unit'
LEFT JOIN fitness.v_human_record_field AS serving_weight_decision
  ON
    serving_weight_decision.user_id = identity.user_id
    AND serving_weight_decision.identity_id = identity.id
    AND serving_weight_decision.field = 'serving_weight_grams';
--> statement-breakpoint

CREATE VIEW fitness.v_food_entry_effective_nutrient AS
SELECT
  effective.record_id,
  effective.source_entry_id,
  effective.user_id,
  effective.provider_id,
  candidate.nutrient_id,
  source.amount AS source_amount,
  CASE
    WHEN decision.operation = 'set' THEN decision.amount
    ELSE source.amount
  END AS amount,
  decision.operation,
  decision.target_id,
  target.change_id
FROM fitness.v_food_entry_effective AS effective
CROSS JOIN LATERAL (
  SELECT nutrient.nutrient_id
  FROM fitness.food_entry_nutrient AS nutrient
  WHERE nutrient.food_entry_id = effective.source_entry_id

  UNION

  SELECT decision.nutrient_id
  FROM fitness.v_human_food_nutrient_decision AS decision
  WHERE decision.identity_id = effective.record_id
) AS candidate
LEFT JOIN fitness.food_entry_nutrient AS source
  ON
    source.food_entry_id = effective.source_entry_id
    AND source.nutrient_id = candidate.nutrient_id
LEFT JOIN fitness.v_human_food_nutrient_decision AS decision
  ON
    decision.user_id = effective.user_id
    AND decision.identity_id = effective.record_id
    AND decision.nutrient_id = candidate.nutrient_id
LEFT JOIN fitness.human_record_target AS target ON target.id = decision.target_id;
--> statement-breakpoint

CREATE VIEW fitness.v_food_entry_with_nutrition AS
WITH nutrients AS (
  SELECT
    source_entry_id,
    MAX(amount) FILTER (WHERE nutrient_id = 'calories')::integer AS calories,
    MAX(amount) FILTER (WHERE nutrient_id = 'protein') AS protein_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'carbohydrate') AS carbs_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'fat') AS fat_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'saturated_fat') AS saturated_fat_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'polyunsaturated_fat') AS polyunsaturated_fat_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'monounsaturated_fat') AS monounsaturated_fat_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'trans_fat') AS trans_fat_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'cholesterol') AS cholesterol_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'sodium') AS sodium_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'potassium') AS potassium_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'fiber') AS fiber_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'sugar') AS sugar_g,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_a') AS vitamin_a_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_c') AS vitamin_c_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_d') AS vitamin_d_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_e') AS vitamin_e_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_k') AS vitamin_k_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b1') AS vitamin_b1_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b2') AS vitamin_b2_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b3') AS vitamin_b3_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b5') AS vitamin_b5_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b6') AS vitamin_b6_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b7') AS vitamin_b7_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b9') AS vitamin_b9_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'vitamin_b12') AS vitamin_b12_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'calcium') AS calcium_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'iron') AS iron_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'magnesium') AS magnesium_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'zinc') AS zinc_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'selenium') AS selenium_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'copper') AS copper_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'manganese') AS manganese_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'chromium') AS chromium_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'iodine') AS iodine_mcg,
    MAX(amount) FILTER (WHERE nutrient_id = 'omega_3') AS omega3_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'omega_6') AS omega6_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'caffeine') AS caffeine_mg,
    MAX(amount) FILTER (WHERE nutrient_id = 'water')::integer AS water_ml
  FROM fitness.v_food_entry_effective_nutrient
  GROUP BY source_entry_id
)
SELECT
  food.source_entry_id AS id,
  food.provider_id,
  food.user_id,
  food.external_id,
  food.date,
  food.meal,
  food.food_name,
  food.food_description,
  food.category,
  food.provider_food_id,
  food.provider_serving_id,
  food.number_of_units,
  food.logged_at,
  food.source_name,
  food.started_at,
  food.ended_at,
  food.barcode,
  food.serving_unit,
  food.serving_weight_grams,
  NULL::uuid AS nutrition_data_id,
  nutrients.calories,
  nutrients.protein_g,
  nutrients.carbs_g,
  nutrients.fat_g,
  nutrients.saturated_fat_g,
  nutrients.polyunsaturated_fat_g,
  nutrients.monounsaturated_fat_g,
  nutrients.trans_fat_g,
  nutrients.cholesterol_mg,
  nutrients.sodium_mg,
  nutrients.potassium_mg,
  nutrients.fiber_g,
  nutrients.sugar_g,
  nutrients.vitamin_a_mcg,
  nutrients.vitamin_c_mg,
  nutrients.vitamin_d_mcg,
  nutrients.vitamin_e_mg,
  nutrients.vitamin_k_mcg,
  nutrients.vitamin_b1_mg,
  nutrients.vitamin_b2_mg,
  nutrients.vitamin_b3_mg,
  nutrients.vitamin_b5_mg,
  nutrients.vitamin_b6_mg,
  nutrients.vitamin_b7_mcg,
  nutrients.vitamin_b9_mcg,
  nutrients.vitamin_b12_mcg,
  nutrients.calcium_mg,
  nutrients.iron_mg,
  nutrients.magnesium_mg,
  nutrients.zinc_mg,
  nutrients.selenium_mcg,
  nutrients.copper_mg,
  nutrients.manganese_mg,
  nutrients.chromium_mcg,
  nutrients.iodine_mcg,
  nutrients.omega3_mg,
  nutrients.omega6_mg,
  nutrients.caffeine_mg,
  nutrients.water_ml,
  food.raw,
  food.confirmed,
  food.created_at
FROM fitness.v_food_entry_effective AS food
LEFT JOIN nutrients ON nutrients.source_entry_id = food.source_entry_id;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_entry_classification AS
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
    WHEN
      NULLIF(BTRIM(food.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(food.source_name)) <> LOWER(provider.name)
      THEN food.provider_id || ':' || BTRIM(food.source_name)
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

CREATE VIEW fitness.v_nutrition_daily_resolution AS
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
    COUNT(DISTINCT source_key) FILTER (WHERE effective_grain = 'daily_aggregate')::integer
      AS aggregate_source_count,
    COUNT(DISTINCT source_key) FILTER (WHERE effective_grain = 'ambiguous')::integer
      AS ambiguous_source_count,
    COUNT(*) FILTER (WHERE effective_grain = 'ambiguous')::integer AS ambiguous_entry_count,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'itemized'),
      ARRAY[]::text []
    ) AS itemized_source_keys,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'daily_aggregate'),
      ARRAY[]::text []
    ) AS aggregate_source_keys,
    COALESCE(
      ARRAY_AGG(DISTINCT source_key ORDER BY source_key)
      FILTER (WHERE effective_grain = 'ambiguous'),
      ARRAY[]::text []
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
          AND grouped.aggregate_source_count = 0
          AND grouped.ambiguous_source_count = 1
          AND grouped.ambiguous_entry_count = 1
        )
        THEN 'source_conflict'
      WHEN grouped.itemized_source_count > 1 THEN 'source_conflict'
      WHEN grouped.itemized_source_count = 1 THEN 'available'
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
          AND grouped.aggregate_source_count = 0
          AND grouped.ambiguous_source_count = 1
          AND grouped.ambiguous_entry_count = 1
        )
        THEN ARRAY[]::text []
      WHEN grouped.itemized_source_count > 1 THEN ARRAY[]::text []
      WHEN grouped.itemized_source_count = 1 THEN grouped.itemized_source_keys
      WHEN grouped.aggregate_source_count > 1 THEN ARRAY[]::text []
      WHEN grouped.aggregate_source_count = 1 THEN grouped.aggregate_source_keys
      WHEN grouped.ambiguous_source_count = 1 AND grouped.ambiguous_entry_count = 1
        THEN grouped.ambiguous_source_keys
      ELSE ARRAY[]::text []
    END AS contributing_source_keys,
    CASE
      WHEN grouped.itemized_source_count = 1 AND grouped.ambiguous_source_count = 0
        THEN 'itemized'
      WHEN
        grouped.itemized_source_count = 0
        AND grouped.aggregate_source_count = 1
        AND grouped.ambiguous_source_count = 0
        THEN 'daily_aggregate'
      WHEN
        grouped.itemized_source_count = 0
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
      THEN 'Totals use the itemized source; overlapping daily aggregate sources are preserved but excluded.'
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

CREATE VIEW fitness.v_nutrition_canonical_nutrient AS
SELECT
  classification.user_id,
  classification.date,
  classification.provider_id,
  classification.id AS food_entry_id,
  NULL::uuid AS supplement_dose_event_id,
  classification.meal,
  nutrient.nutrient_id,
  nutrient.amount,
  classification.created_at
FROM fitness.v_nutrition_entry_classification AS classification
INNER JOIN fitness.v_nutrition_daily_resolution AS resolution
  ON
    classification.user_id = resolution.user_id
    AND classification.date = resolution.date
INNER JOIN fitness.v_food_entry_effective_nutrient AS nutrient
  ON classification.id = nutrient.source_entry_id
WHERE
  resolution.resolution_status = 'available'
  AND classification.confirmed = TRUE
  AND classification.source_key = ANY(resolution.contributing_source_keys)
  AND classification.effective_grain = resolution.contribution_grain
  AND nutrient.amount IS NOT NULL

UNION ALL

SELECT
  event.user_id,
  event.scheduled_date AS date,
  event.provider_id,
  NULL::uuid AS food_entry_id,
  event.id AS supplement_dose_event_id,
  definition.meal,
  nutrient.nutrient_id,
  nutrient.amount,
  event.created_at
FROM fitness.v_supplement_dose_current AS event
INNER JOIN fitness.supplement_definition AS definition
  ON event.definition_id = definition.id
INNER JOIN fitness.supplement_definition_nutrient AS nutrient
  ON definition.id = nutrient.definition_id
LEFT JOIN fitness.v_nutrition_daily_resolution AS resolution
  ON event.user_id = resolution.user_id AND event.scheduled_date = resolution.date
WHERE
  event.status = 'taken'
  AND (resolution.resolution_status IS NULL OR resolution.resolution_status = 'available');
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_daily AS
WITH supplement_sources AS (
  SELECT
    event.user_id,
    event.scheduled_date AS date,
    ARRAY_AGG(DISTINCT event.provider_id ORDER BY event.provider_id) AS provider_ids,
    ARRAY_AGG(
      DISTINCT COALESCE(NULLIF(BTRIM(event.source_name), ''), event.provider_id)
      ORDER BY COALESCE(NULLIF(BTRIM(event.source_name), ''), event.provider_id)
    ) AS source_labels
  FROM fitness.v_supplement_dose_current AS event
  WHERE event.status = 'taken'
  GROUP BY event.user_id, event.scheduled_date
),

date_context AS (
  SELECT
    COALESCE(resolution.user_id, supplement.user_id) AS user_id,
    COALESCE(resolution.date, supplement.date) AS date,
    COALESCE(resolution.resolution_status, 'available') AS resolution_status,
    CASE
      WHEN resolution.user_id IS NULL
        THEN 'Totals use explicitly taken supplement doses.'
      WHEN resolution.resolution_status = 'available' AND supplement.user_id IS NOT NULL
        THEN resolution.resolution_message || ' Explicitly taken supplement doses are included.'
      ELSE resolution.resolution_message
    END AS resolution_message,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.source_providers, ARRAY[]::text [])
        || COALESCE(supplement.provider_ids, ARRAY[]::text [])
      ) AS value
      ORDER BY value
    ) AS source_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.contributing_providers, ARRAY[]::text [])
        || CASE
          WHEN resolution.user_id IS NULL OR resolution.resolution_status = 'available'
            THEN COALESCE(supplement.provider_ids, ARRAY[]::text [])
          ELSE ARRAY[]::text []
        END
      ) AS value
      ORDER BY value
    ) AS contributing_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.excluded_providers, ARRAY[]::text [])
        || CASE
          WHEN resolution.resolution_status = 'source_conflict'
            THEN COALESCE(supplement.provider_ids, ARRAY[]::text [])
          ELSE ARRAY[]::text []
        END
      ) AS value
      ORDER BY value
    ) AS excluded_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.source_labels, ARRAY[]::text [])
        || COALESCE(supplement.source_labels, ARRAY[]::text [])
      ) AS value
      ORDER BY value
    ) AS source_labels,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.contributing_source_labels, ARRAY[]::text [])
        || CASE
          WHEN resolution.user_id IS NULL OR resolution.resolution_status = 'available'
            THEN COALESCE(supplement.source_labels, ARRAY[]::text [])
          ELSE ARRAY[]::text []
        END
      ) AS value
      ORDER BY value
    ) AS contributing_source_labels,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.excluded_source_labels, ARRAY[]::text [])
        || CASE
          WHEN resolution.resolution_status = 'source_conflict'
            THEN COALESCE(supplement.source_labels, ARRAY[]::text [])
          ELSE ARRAY[]::text []
        END
      ) AS value
      ORDER BY value
    ) AS excluded_source_labels,
    resolution.contribution_grain,
    resolution.contributing_source_labels[1] AS contribution_source_label
  FROM fitness.v_nutrition_daily_resolution AS resolution
  FULL OUTER JOIN supplement_sources AS supplement
    ON resolution.user_id = supplement.user_id AND resolution.date = supplement.date
)

SELECT
  context.date,
  context.user_id,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer
  END AS calories,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein')
  END AS protein_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate')
  END AS carbs_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat')
  END AS fat_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'saturated_fat')
  END AS saturated_fat_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'polyunsaturated_fat')
  END AS polyunsaturated_fat_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'monounsaturated_fat')
  END AS monounsaturated_fat_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'trans_fat')
  END AS trans_fat_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'cholesterol')
  END AS cholesterol_mg,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sodium')
  END AS sodium_mg,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'potassium')
  END AS potassium_mg,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fiber')
  END AS fiber_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sugar')
  END AS sugar_g,
  CASE WHEN context.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'water')::integer
  END AS water_ml,
  CASE WHEN context.resolution_status = 'available' THEN MIN(nutrient.created_at) END AS created_at,
  context.resolution_status,
  context.resolution_message,
  context.source_providers,
  context.contributing_providers,
  context.excluded_providers,
  context.source_labels,
  context.contributing_source_labels,
  context.excluded_source_labels,
  context.contribution_grain,
  context.contribution_source_label
FROM date_context AS context
LEFT JOIN fitness.v_nutrition_canonical_nutrient AS nutrient
  ON context.user_id = nutrient.user_id AND context.date = nutrient.date
GROUP BY
  context.date,
  context.user_id,
  context.resolution_status,
  context.resolution_message,
  context.source_providers,
  context.contributing_providers,
  context.excluded_providers,
  context.source_labels,
  context.contributing_source_labels,
  context.excluded_source_labels,
  context.contribution_grain,
  context.contribution_source_label;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_display_entry AS
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
WHERE classification.effective_grain = 'itemized';
