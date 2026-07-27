DROP VIEW fitness.v_supplement_with_nutrition;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD COLUMN schedule_id uuid;
--> statement-breakpoint

UPDATE fitness.supplement
SET schedule_id = id
WHERE schedule_id IS NULL;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ALTER COLUMN schedule_id SET NOT NULL;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD COLUMN supersedes_supplement_id uuid;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD COLUMN effective_from date;
--> statement-breakpoint

UPDATE fitness.supplement
SET effective_from = (created_at AT TIME ZONE 'UTC')::date
WHERE effective_from IS NULL;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ALTER COLUMN effective_from SET NOT NULL;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ALTER COLUMN effective_from SET DEFAULT CURRENT_DATE;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD COLUMN effective_to date;
--> statement-breakpoint

DROP INDEX fitness.supplement_user_name_idx;
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD CONSTRAINT supplement_id_user_schedule_key
UNIQUE (id, user_id, schedule_id);
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD CONSTRAINT supplement_supersedes_fkey
FOREIGN KEY (supersedes_supplement_id, user_id, schedule_id)
REFERENCES fitness.supplement(id, user_id, schedule_id);
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD CONSTRAINT supplement_supersedes_key
UNIQUE (supersedes_supplement_id);
--> statement-breakpoint

ALTER TABLE fitness.supplement
ADD CONSTRAINT supplement_effective_interval_valid
CHECK (effective_to IS NULL OR effective_to >= effective_from);
--> statement-breakpoint

CREATE UNIQUE INDEX supplement_user_name_active_idx
ON fitness.supplement (user_id, name)
WHERE effective_to IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX supplement_user_schedule_active_idx
ON fitness.supplement (user_id, schedule_id)
WHERE effective_to IS NULL;
--> statement-breakpoint

CREATE INDEX supplement_user_effective_idx
ON fitness.supplement (user_id, effective_from, effective_to);
--> statement-breakpoint

CREATE TYPE fitness.supplement_dose_status AS ENUM (
  'planned',
  'taken',
  'skipped',
  'unknown'
);
--> statement-breakpoint

CREATE TABLE fitness.supplement_dose_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  supplement_id uuid NOT NULL,
  provider_id text NOT NULL,
  external_id text,
  scheduled_date date NOT NULL,
  status fitness.supplement_dose_status NOT NULL,
  supersedes_event_id uuid,
  recorded_at timestamp with time zone NOT NULL,
  source_name text,
  raw jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT supplement_dose_event_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id),
  CONSTRAINT supplement_dose_event_provider_id_fkey
    FOREIGN KEY (provider_id) REFERENCES fitness.provider(id),
  CONSTRAINT supplement_dose_event_definition_fkey
    FOREIGN KEY (supplement_id, user_id, schedule_id)
    REFERENCES fitness.supplement(id, user_id, schedule_id),
  CONSTRAINT supplement_dose_event_slot_identity_key
    UNIQUE (id, user_id, schedule_id, supplement_id, scheduled_date),
  CONSTRAINT supplement_dose_event_successor_key
    UNIQUE (supersedes_event_id),
  CONSTRAINT supplement_dose_event_supersedes_fkey
    FOREIGN KEY (
      supersedes_event_id,
      user_id,
      schedule_id,
      supplement_id,
      scheduled_date
    )
    REFERENCES fitness.supplement_dose_event(
      id,
      user_id,
      schedule_id,
      supplement_id,
      scheduled_date
    ),
  CONSTRAINT supplement_dose_event_not_self_superseding
    CHECK (supersedes_event_id IS NULL OR supersedes_event_id <> id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX supplement_dose_event_root_key
ON fitness.supplement_dose_event (user_id, schedule_id, scheduled_date)
WHERE supersedes_event_id IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX supplement_dose_event_provider_external_idx
ON fitness.supplement_dose_event (user_id, provider_id, external_id)
WHERE external_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX supplement_dose_event_user_date_idx
ON fitness.supplement_dose_event (user_id, scheduled_date);
--> statement-breakpoint

CREATE INDEX supplement_dose_event_supplement_idx
ON fitness.supplement_dose_event (supplement_id);
--> statement-breakpoint

DELETE FROM fitness.food_entry
WHERE provider_id = 'auto-supplements';
--> statement-breakpoint

CREATE VIEW fitness.v_supplement_with_nutrition AS
SELECT
  s.id,
  s.user_id,
  s.schedule_id,
  s.supersedes_supplement_id,
  s.name,
  s.amount,
  s.unit,
  s.form,
  s.description,
  s.meal,
  s.sort_order,
  s.effective_from,
  s.effective_to,
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
  NULL::integer AS water_ml,
  s.created_at,
  s.updated_at
FROM fitness.supplement AS s
LEFT JOIN fitness.supplement_nutrient AS sn ON sn.supplement_id = s.id
WHERE s.effective_to IS NULL
GROUP BY s.id;
--> statement-breakpoint

CREATE VIEW fitness.v_supplement_dose_current AS
SELECT event.*
FROM fitness.supplement_dose_event AS event
WHERE NOT EXISTS (
  SELECT 1
  FROM fitness.supplement_dose_event AS successor
  WHERE successor.supersedes_event_id = event.id
);
--> statement-breakpoint

DROP VIEW fitness.v_nutrition_daily;
--> statement-breakpoint

DROP VIEW fitness.v_nutrition_canonical_nutrient;
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
INNER JOIN fitness.food_entry_nutrient AS nutrient
  ON classification.id = nutrient.food_entry_id
WHERE
  resolution.resolution_status = 'available'
  AND classification.confirmed = TRUE
  AND classification.source_key = ANY(resolution.contributing_source_keys)
  AND classification.effective_grain = resolution.contribution_grain

UNION ALL

SELECT
  event.user_id,
  event.scheduled_date AS date,
  event.provider_id,
  NULL::uuid AS food_entry_id,
  event.id AS supplement_dose_event_id,
  supplement.meal,
  nutrient.nutrient_id,
  nutrient.amount,
  event.created_at
FROM fitness.v_supplement_dose_current AS event
INNER JOIN fitness.supplement AS supplement
  ON
    supplement.id = event.supplement_id
    AND supplement.user_id = event.user_id
    AND supplement.schedule_id = event.schedule_id
INNER JOIN fitness.supplement_nutrient AS nutrient
  ON nutrient.supplement_id = supplement.id
LEFT JOIN fitness.v_nutrition_daily_resolution AS resolution
  ON
    resolution.user_id = event.user_id
    AND resolution.date = event.scheduled_date
WHERE
  event.status = 'taken'
  AND (
    resolution.resolution_status IS NULL
    OR resolution.resolution_status = 'available'
  );
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
        COALESCE(resolution.source_providers, ARRAY[]::text[])
        || COALESCE(supplement.provider_ids, ARRAY[]::text[])
      ) AS value
      ORDER BY value
    ) AS source_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.contributing_providers, ARRAY[]::text[])
        || CASE
          WHEN resolution.user_id IS NULL OR resolution.resolution_status = 'available'
            THEN COALESCE(supplement.provider_ids, ARRAY[]::text[])
          ELSE ARRAY[]::text[]
        END
      ) AS value
      ORDER BY value
    ) AS contributing_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.excluded_providers, ARRAY[]::text[])
        || CASE
          WHEN resolution.resolution_status = 'source_conflict'
            THEN COALESCE(supplement.provider_ids, ARRAY[]::text[])
          ELSE ARRAY[]::text[]
        END
      ) AS value
      ORDER BY value
    ) AS excluded_providers,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.source_labels, ARRAY[]::text[])
        || COALESCE(supplement.source_labels, ARRAY[]::text[])
      ) AS value
      ORDER BY value
    ) AS source_labels,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.contributing_source_labels, ARRAY[]::text[])
        || CASE
          WHEN resolution.user_id IS NULL OR resolution.resolution_status = 'available'
            THEN COALESCE(supplement.source_labels, ARRAY[]::text[])
          ELSE ARRAY[]::text[]
        END
      ) AS value
      ORDER BY value
    ) AS contributing_source_labels,
    ARRAY(
      SELECT DISTINCT value
      FROM UNNEST(
        COALESCE(resolution.excluded_source_labels, ARRAY[]::text[])
        || CASE
          WHEN resolution.resolution_status = 'source_conflict'
            THEN COALESCE(supplement.source_labels, ARRAY[]::text[])
          ELSE ARRAY[]::text[]
        END
      ) AS value
      ORDER BY value
    ) AS excluded_source_labels
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
  context.excluded_source_labels
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
  context.excluded_source_labels;
