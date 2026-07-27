CREATE TYPE fitness.nutrition_entry_grain AS ENUM ('itemized', 'daily_aggregate');
--> statement-breakpoint

ALTER TABLE fitness.food_entry
ADD COLUMN nutrition_grain fitness.nutrition_entry_grain;
--> statement-breakpoint

ALTER VIEW fitness.v_nutrition_daily
RENAME TO v_nutrition_provider_daily;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_entry_classification AS
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
  fe.provider_id || ':' || COALESCE(NULLIF(BTRIM(fe.source_name), ''), 'provider') AS source_key,
  CASE
    WHEN NULLIF(BTRIM(fe.source_name), '') IS NULL THEN fe.provider_id
    ELSE fe.provider_id || ' / ' || BTRIM(fe.source_name)
  END AS source_label
FROM fitness.food_entry AS fe
LEFT JOIN nutrient_counts AS nc ON fe.id = nc.food_entry_id;
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
      WHEN grouped.ambiguous_source_count = 1 AND grouped.ambiguous_entry_count = 1 THEN grouped.ambiguous_source_keys
      ELSE ARRAY[]::text []
    END AS contributing_source_keys,
    CASE
      WHEN
        grouped.itemized_source_count = 1
        AND grouped.ambiguous_source_count = 0
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
    SELECT DISTINCT c.provider_id
    FROM confirmed AS c
    WHERE
      c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND c.source_key = ANY(decisions.contributing_source_keys)
    ORDER BY c.provider_id
  ) AS contributing_providers,
  ARRAY(
    SELECT DISTINCT c.provider_id
    FROM confirmed AS c
    WHERE
      c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND NOT (c.source_key = ANY(decisions.contributing_source_keys))
    ORDER BY c.provider_id
  ) AS excluded_providers,
  ARRAY(
    SELECT DISTINCT c.source_label
    FROM confirmed AS c
    WHERE
      c.user_id = decisions.user_id
      AND c.date = decisions.date
    ORDER BY c.source_label
  ) AS source_labels,
  ARRAY(
    SELECT DISTINCT c.source_label
    FROM confirmed AS c
    WHERE
      c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND c.source_key = ANY(decisions.contributing_source_keys)
    ORDER BY c.source_label
  ) AS contributing_source_labels,
  ARRAY(
    SELECT DISTINCT c.source_label
    FROM confirmed AS c
    WHERE
      c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND NOT (c.source_key = ANY(decisions.contributing_source_keys))
    ORDER BY c.source_label
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
  nutrient.nutrient_id,
  nutrient.amount
FROM fitness.v_nutrition_entry_classification AS classification
INNER JOIN fitness.v_nutrition_daily_resolution AS resolution
  ON
    classification.user_id = resolution.user_id
    AND classification.date = resolution.date
INNER JOIN fitness.food_entry_nutrient AS nutrient
  ON classification.id = nutrient.food_entry_id
WHERE
  resolution.resolution_status = 'available'
  AND classification.confirmed = TRUE
  AND classification.source_key = ANY(resolution.contributing_source_keys)
  AND classification.effective_grain = resolution.contribution_grain;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_daily AS
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
  resolution.excluded_source_labels
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
  resolution.excluded_source_labels;
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
INNER JOIN fitness.v_nutrition_entry_classification AS classification ON entry.id = classification.id
WHERE classification.effective_grain = 'itemized';
