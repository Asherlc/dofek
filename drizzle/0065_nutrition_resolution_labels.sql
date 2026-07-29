CREATE OR REPLACE VIEW fitness.v_nutrition_entry_classification AS
WITH nutrient_counts AS (
  SELECT
    food_entry_id,
    COUNT(*)::integer AS nutrient_count
  FROM fitness.food_entry_nutrient
  GROUP BY food_entry_id
)

SELECT
  fe.id,
  fe.provider_id,
  fe.user_id,
  fe.date,
  fe.nutrition_grain,
  fe.meal,
  fe.food_name,
  fe.provider_food_id,
  fe.provider_serving_id,
  fe.source_name,
  fe.confirmed,
  fe.created_at,
  COALESCE(nc.nutrient_count, 0) AS nutrient_count,
  COALESCE(
    fe.nutrition_grain::text,
    CASE
      WHEN
        NULLIF(BTRIM(fe.food_name), '') IS NOT NULL
        OR fe.meal IS NOT NULL
        OR fe.provider_food_id IS NOT NULL
        OR fe.provider_serving_id IS NOT NULL
        THEN 'itemized'
      WHEN COALESCE(nc.nutrient_count, 0) = 1
        THEN 'daily_aggregate'
      ELSE 'ambiguous'
    END
  ) AS effective_grain,
  CASE
    WHEN
      fe.provider_id = 'apple_health'
      AND NULLIF(BTRIM(fe.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(fe.source_name)) <> LOWER(provider.name)
      THEN fe.provider_id || ':' || BTRIM(fe.source_name)
    ELSE fe.provider_id || ':provider'
  END AS source_key,
  CASE
    WHEN
      fe.provider_id = 'apple_health'
      AND NULLIF(BTRIM(fe.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(fe.source_name)) <> LOWER(provider.name)
      THEN BTRIM(fe.source_name) || ' (via ' || provider.name || ')'
    ELSE COALESCE(provider.name, fe.provider_id)
  END AS source_label
FROM fitness.food_entry AS fe
LEFT JOIN fitness.provider AS provider ON fe.provider_id = provider.id
LEFT JOIN nutrient_counts AS nc ON fe.id = nc.food_entry_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_nutrition_daily AS
SELECT
  resolution.date,
  resolution.user_id,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer
  END AS calories,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein')
  END AS protein_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate')
  END AS carbs_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat')
  END AS fat_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'saturated_fat')
  END AS saturated_fat_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'polyunsaturated_fat')
  END AS polyunsaturated_fat_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'monounsaturated_fat')
  END AS monounsaturated_fat_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'trans_fat')
  END AS trans_fat_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'cholesterol')
  END AS cholesterol_mg,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sodium')
  END AS sodium_mg,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'potassium')
  END AS potassium_mg,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fiber')
  END AS fiber_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sugar')
  END AS sugar_g,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'water')::integer
  END AS water_ml,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN MIN(classification.created_at)
  END AS created_at,
  resolution.resolution_status,
  resolution.resolution_message,
  resolution.source_providers,
  resolution.contributing_providers,
  resolution.excluded_providers,
  resolution.source_labels,
  resolution.contributing_source_labels,
  resolution.excluded_source_labels,
  resolution.contribution_grain
FROM fitness.v_nutrition_daily_resolution AS resolution
LEFT JOIN fitness.v_nutrition_canonical_nutrient AS nutrient
  ON
    resolution.user_id = nutrient.user_id
    AND resolution.date = nutrient.date
LEFT JOIN fitness.v_nutrition_entry_classification AS classification
  ON nutrient.food_entry_id = classification.id
GROUP BY
  resolution.date,
  resolution.user_id,
  resolution.resolution_status,
  resolution.resolution_message,
  resolution.source_providers,
  resolution.contributing_providers,
  resolution.excluded_providers,
  resolution.source_labels,
  resolution.contributing_source_labels,
  resolution.excluded_source_labels,
  resolution.contribution_grain;
