CREATE TYPE fitness.nutrition_entry_grain AS ENUM ('itemized', 'daily_aggregate');
--> statement-breakpoint

ALTER TABLE fitness.food_entry
ADD COLUMN nutrition_grain fitness.nutrition_entry_grain;
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
  fe.*,
  COALESCE(nc.nutrient_count, 0) AS nutrient_count,
  COALESCE(
    fe.nutrition_grain::text,
    CASE
      WHEN NULLIF(BTRIM(fe.food_name), '') IS NOT NULL
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
FROM fitness.food_entry fe
LEFT JOIN nutrient_counts nc ON nc.food_entry_id = fe.id;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_daily_resolution AS
WITH confirmed AS (
  SELECT *
  FROM fitness.v_nutrition_entry_classification
  WHERE confirmed = true
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
      ARRAY[]::text[]
    ) AS itemized_source_keys,
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
      WHEN ambiguous_source_count > 0
        AND NOT (
          itemized_source_count = 0
          AND aggregate_source_count = 0
          AND ambiguous_source_count = 1
          AND ambiguous_entry_count = 1
        )
        THEN 'source_conflict'
      WHEN itemized_source_count > 1 THEN 'source_conflict'
      WHEN itemized_source_count = 1 THEN 'available'
      WHEN aggregate_source_count > 1 THEN 'source_conflict'
      WHEN aggregate_source_count = 1 THEN 'available'
      WHEN ambiguous_source_count = 1 AND ambiguous_entry_count = 1 THEN 'available'
      ELSE 'source_conflict'
    END AS resolution_status,
    CASE
      WHEN ambiguous_source_count > 0
        AND NOT (
          itemized_source_count = 0
          AND aggregate_source_count = 0
          AND ambiguous_source_count = 1
          AND ambiguous_entry_count = 1
        )
        THEN ARRAY[]::text[]
      WHEN itemized_source_count > 1 THEN ARRAY[]::text[]
      WHEN itemized_source_count = 1 THEN itemized_source_keys
      WHEN aggregate_source_count > 1 THEN ARRAY[]::text[]
      WHEN aggregate_source_count = 1 THEN aggregate_source_keys
      WHEN ambiguous_source_count = 1 AND ambiguous_entry_count = 1 THEN ambiguous_source_keys
      ELSE ARRAY[]::text[]
    END AS contributing_source_keys,
    CASE
      WHEN itemized_source_count = 1
        AND ambiguous_source_count = 0
        THEN 'itemized'
      WHEN itemized_source_count = 0
        AND aggregate_source_count = 1
        AND ambiguous_source_count = 0
        THEN 'daily_aggregate'
      WHEN itemized_source_count = 0
        AND aggregate_source_count = 0
        AND ambiguous_source_count = 1
        AND ambiguous_entry_count = 1
        THEN 'ambiguous'
      ELSE NULL
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
    FROM confirmed c
    WHERE c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND c.source_key = ANY(decisions.contributing_source_keys)
    ORDER BY c.provider_id
  ) AS contributing_providers,
  ARRAY(
    SELECT DISTINCT c.provider_id
    FROM confirmed c
    WHERE c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND NOT (c.source_key = ANY(decisions.contributing_source_keys))
    ORDER BY c.provider_id
  ) AS excluded_providers,
  ARRAY(
    SELECT DISTINCT c.source_label
    FROM confirmed c
    WHERE c.user_id = decisions.user_id
      AND c.date = decisions.date
    ORDER BY c.source_label
  ) AS source_labels,
  ARRAY(
    SELECT DISTINCT c.source_label
    FROM confirmed c
    WHERE c.user_id = decisions.user_id
      AND c.date = decisions.date
      AND c.source_key = ANY(decisions.contributing_source_keys)
    ORDER BY c.source_label
  ) AS contributing_source_labels,
  ARRAY(
    SELECT DISTINCT c.source_label
    FROM confirmed c
    WHERE c.user_id = decisions.user_id
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
FROM fitness.v_nutrition_entry_classification classification
JOIN fitness.v_nutrition_daily_resolution resolution
  ON resolution.user_id = classification.user_id
  AND resolution.date = classification.date
JOIN fitness.food_entry_nutrient nutrient
  ON nutrient.food_entry_id = classification.id
WHERE resolution.resolution_status = 'available'
  AND classification.source_key = ANY(resolution.contributing_source_keys)
  AND classification.effective_grain = resolution.contribution_grain;
--> statement-breakpoint

CREATE VIEW fitness.v_nutrition_canonical_daily AS
SELECT
  resolution.date,
  resolution.user_id,
  CASE
    WHEN resolution.resolution_status = 'available'
      THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer
    ELSE NULL
  END AS calories,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein') END AS protein_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate') END AS carbs_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat') END AS fat_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'saturated_fat') END AS saturated_fat_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'polyunsaturated_fat') END AS polyunsaturated_fat_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'monounsaturated_fat') END AS monounsaturated_fat_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'trans_fat') END AS trans_fat_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'cholesterol') END AS cholesterol_mg,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sodium') END AS sodium_mg,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'potassium') END AS potassium_mg,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fiber') END AS fiber_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sugar') END AS sugar_g,
  CASE WHEN resolution.resolution_status = 'available'
    THEN SUM(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'water')::integer END AS water_ml,
  CASE WHEN resolution.resolution_status = 'available'
    THEN MIN(classification.created_at) END AS created_at,
  resolution.resolution_status,
  resolution.resolution_message,
  resolution.source_providers,
  resolution.contributing_providers,
  resolution.excluded_providers,
  resolution.source_labels,
  resolution.contributing_source_labels,
  resolution.excluded_source_labels
FROM fitness.v_nutrition_daily_resolution resolution
LEFT JOIN fitness.v_nutrition_canonical_nutrient nutrient
  ON nutrient.user_id = resolution.user_id
  AND nutrient.date = resolution.date
LEFT JOIN fitness.v_nutrition_entry_classification classification
  ON classification.id = nutrient.food_entry_id
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
SELECT entry.*
FROM fitness.v_food_entry_with_nutrition entry
JOIN fitness.v_nutrition_entry_classification classification ON classification.id = entry.id
WHERE classification.effective_grain = 'itemized';
