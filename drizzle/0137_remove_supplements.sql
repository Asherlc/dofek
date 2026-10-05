DROP VIEW fitness.v_nutrition_daily;
--> statement-breakpoint

DROP VIEW fitness.v_nutrition_canonical_nutrient;
--> statement-breakpoint

DROP VIEW fitness.v_supplement_with_nutrition;
--> statement-breakpoint

DROP VIEW fitness.v_supplement_dose_current;
--> statement-breakpoint

DROP TABLE fitness.supplement_dose_event;
--> statement-breakpoint

DROP TABLE fitness.supplement_definition_nutrient;
--> statement-breakpoint

DROP TABLE fitness.supplement_definition;
--> statement-breakpoint

DROP TABLE fitness.supplement;
--> statement-breakpoint

DROP TYPE fitness.supplement_dose_status;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_canonical_nutrient AS
SELECT
  classification.user_id,
  classification.date,
  classification.provider_id,
  classification.id AS food_entry_id,
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
  AND nutrient.amount IS NOT NULL;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_daily AS
SELECT
  context.date,
  context.user_id,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer
  END AS calories,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein')
  END AS protein_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate')
  END AS carbs_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat')
  END AS fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'saturated_fat')
  END AS saturated_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'polyunsaturated_fat')
  END AS polyunsaturated_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'monounsaturated_fat')
  END AS monounsaturated_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'trans_fat')
  END AS trans_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'cholesterol')
  END AS cholesterol_mg,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sodium')
  END AS sodium_mg,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'potassium')
  END AS potassium_mg,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fiber')
  END AS fiber_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sugar')
  END AS sugar_g,
  CASE
    WHEN context.resolution_status = 'available'
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
  context.contributing_source_labels[1] AS contribution_source_label
FROM fitness.v_nutrition_daily_resolution AS context
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
  context.contributing_source_labels[1];
