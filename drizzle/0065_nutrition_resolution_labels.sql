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
      NULLIF(BTRIM(fe.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(fe.source_name)) <> LOWER(provider.name)
      THEN fe.provider_id || ':' || BTRIM(fe.source_name)
    ELSE fe.provider_id || ':provider'
  END AS source_key,
  CASE
    WHEN
      NULLIF(BTRIM(fe.source_name), '') IS NOT NULL
      AND LOWER(BTRIM(fe.source_name)) <> LOWER(COALESCE(provider.name, fe.provider_id))
      THEN
        BTRIM(fe.source_name)
        || ' (via '
        || provider.name
        || ')'
    ELSE provider.name
  END AS source_label
FROM fitness.food_entry AS fe
INNER JOIN fitness.provider AS provider ON fe.provider_id = provider.id
LEFT JOIN nutrient_counts AS nc ON fe.id = nc.food_entry_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW fitness.v_nutrition_daily AS
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
      FROM
        UNNEST(
          COALESCE(resolution.source_providers, ARRAY[]::text [])
          || COALESCE(supplement.provider_ids, ARRAY[]::text [])
        ) AS value
      ORDER BY value
    ) AS source_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM
        UNNEST(
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
      FROM
        UNNEST(
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
      FROM
        UNNEST(
          COALESCE(resolution.source_labels, ARRAY[]::text [])
          || COALESCE(supplement.source_labels, ARRAY[]::text [])
        ) AS value
      ORDER BY value
    ) AS source_labels,
    ARRAY(
      SELECT DISTINCT value
      FROM
        UNNEST(
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
      FROM
        UNNEST(
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
    ON
      resolution.user_id = supplement.user_id
      AND resolution.date = supplement.date
)

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
  CASE
    WHEN context.resolution_status = 'available'
      THEN MIN(nutrient.created_at)
  END AS created_at,
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
  ON
    context.user_id = nutrient.user_id
    AND context.date = nutrient.date
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
