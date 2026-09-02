DROP VIEW fitness.v_supplement_with_nutrition;
--> statement-breakpoint

ALTER TABLE fitness.supplement
RENAME TO supplement_legacy;
--> statement-breakpoint

ALTER TABLE fitness.supplement_nutrient
RENAME TO supplement_nutrient_legacy;
--> statement-breakpoint

CREATE TABLE fitness.supplement_schedule_new (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  sort_order bigint DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT supplement_schedule_new_pkey PRIMARY KEY (id),
  CONSTRAINT supplement_schedule_new_id_user_key UNIQUE (id, user_id),
  CONSTRAINT supplement_schedule_new_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id)
);
--> statement-breakpoint

CREATE INDEX supplement_schedule_new_user_idx
ON fitness.supplement_schedule_new (user_id);
--> statement-breakpoint

INSERT INTO fitness.supplement_schedule_new (
  id,
  user_id,
  sort_order,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  sort_order,
  created_at,
  updated_at
FROM fitness.supplement_legacy;
--> statement-breakpoint

CREATE TABLE fitness.supplement_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  supplement_id uuid NOT NULL,
  supersedes_definition_id uuid,
  name text NOT NULL,
  amount real,
  unit text,
  form text,
  description text,
  meal fitness.meal,
  effective_from date DEFAULT current_date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT supplement_definition_supplement_id_fkey
  FOREIGN KEY (supplement_id)
  REFERENCES fitness.supplement_schedule_new (id)
  ON DELETE CASCADE,
  CONSTRAINT supplement_definition_identity_key
  UNIQUE (id, supplement_id),
  CONSTRAINT supplement_definition_supersedes_key
  UNIQUE (supersedes_definition_id),
  CONSTRAINT supplement_definition_supersedes_fkey
  FOREIGN KEY (supersedes_definition_id, supplement_id)
  REFERENCES fitness.supplement_definition (id, supplement_id),
  CONSTRAINT supplement_definition_effective_interval_valid
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT supplement_definition_not_self_superseding
  CHECK (supersedes_definition_id IS NULL OR supersedes_definition_id <> id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX supplement_definition_active_idx
ON fitness.supplement_definition (supplement_id)
WHERE effective_to IS NULL;
--> statement-breakpoint

CREATE INDEX supplement_definition_effective_idx
ON fitness.supplement_definition (supplement_id, effective_from, effective_to);
--> statement-breakpoint

CREATE TABLE fitness.supplement_definition_nutrient (
  definition_id uuid NOT NULL,
  nutrient_id text NOT NULL,
  amount real NOT NULL,
  CONSTRAINT supplement_definition_nutrient_pkey
  PRIMARY KEY (definition_id, nutrient_id),
  CONSTRAINT supplement_definition_nutrient_definition_id_fkey
  FOREIGN KEY (definition_id)
  REFERENCES fitness.supplement_definition (id)
  ON DELETE CASCADE,
  CONSTRAINT supplement_definition_nutrient_nutrient_id_fkey
  FOREIGN KEY (nutrient_id) REFERENCES fitness.nutrient (id)
);
--> statement-breakpoint

CREATE INDEX supplement_definition_nutrient_definition_idx
ON fitness.supplement_definition_nutrient (definition_id);
--> statement-breakpoint

INSERT INTO fitness.supplement_definition (
  id,
  supplement_id,
  name,
  amount,
  unit,
  form,
  description,
  meal,
  effective_from,
  created_at
)
SELECT
  id,
  id AS supplement_id,
  name,
  amount,
  unit,
  form,
  description,
  meal,
  (created_at AT TIME ZONE 'UTC')::date,
  created_at
FROM fitness.supplement_legacy;
--> statement-breakpoint

INSERT INTO fitness.supplement_definition_nutrient (
  definition_id,
  nutrient_id,
  amount
)
SELECT
  supplement_id,
  nutrient_id,
  amount
FROM fitness.supplement_nutrient_legacy;
--> statement-breakpoint

DROP TABLE fitness.supplement_nutrient_legacy;
--> statement-breakpoint

DROP TABLE fitness.supplement_legacy;
--> statement-breakpoint

ALTER TABLE fitness.supplement_schedule_new
RENAME TO supplement;
--> statement-breakpoint

ALTER TABLE fitness.supplement
RENAME CONSTRAINT supplement_schedule_new_pkey TO supplement_pkey;
--> statement-breakpoint

ALTER TABLE fitness.supplement
RENAME CONSTRAINT supplement_schedule_new_id_user_key TO supplement_id_user_key;
--> statement-breakpoint

ALTER TABLE fitness.supplement
RENAME CONSTRAINT supplement_schedule_new_user_id_fkey TO supplement_user_id_fkey;
--> statement-breakpoint

ALTER INDEX fitness.supplement_schedule_new_user_idx
RENAME TO supplement_user_idx;
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
  supplement_id uuid NOT NULL,
  definition_id uuid NOT NULL,
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
  FOREIGN KEY (user_id) REFERENCES fitness.user_profile (id),
  CONSTRAINT supplement_dose_event_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES fitness.provider (id),
  CONSTRAINT supplement_dose_event_supplement_user_fkey
  FOREIGN KEY (supplement_id, user_id)
  REFERENCES fitness.supplement (id, user_id),
  CONSTRAINT supplement_dose_event_definition_fkey
  FOREIGN KEY (definition_id, supplement_id)
  REFERENCES fitness.supplement_definition (id, supplement_id),
  CONSTRAINT supplement_dose_event_slot_identity_key
  UNIQUE (id, user_id, supplement_id, definition_id, scheduled_date),
  CONSTRAINT supplement_dose_event_successor_key
  UNIQUE (supersedes_event_id),
  CONSTRAINT supplement_dose_event_supersedes_fkey
  FOREIGN KEY (
    supersedes_event_id,
    user_id,
    supplement_id,
    definition_id,
    scheduled_date
  )
  REFERENCES fitness.supplement_dose_event (
    id,
    user_id,
    supplement_id,
    definition_id,
    scheduled_date
  ),
  CONSTRAINT supplement_dose_event_not_self_superseding
  CHECK (supersedes_event_id IS NULL OR supersedes_event_id <> id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX supplement_dose_event_root_key
ON fitness.supplement_dose_event (user_id, supplement_id, scheduled_date)
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
  definition.id AS definition_id,
  supplement.id AS supplement_id,
  supplement.id AS schedule_id,
  definition.supersedes_definition_id,
  supplement.user_id,
  definition.name,
  definition.amount,
  definition.unit,
  definition.form,
  definition.description,
  definition.meal,
  supplement.sort_order,
  definition.effective_from,
  definition.effective_to,
  NULL::uuid AS nutrition_data_id,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer AS calories,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein') AS protein_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate') AS carbs_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat') AS fat_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'saturated_fat') AS saturated_fat_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'polyunsaturated_fat') AS polyunsaturated_fat_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'monounsaturated_fat') AS monounsaturated_fat_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'trans_fat') AS trans_fat_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'cholesterol') AS cholesterol_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sodium') AS sodium_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'potassium') AS potassium_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fiber') AS fiber_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sugar') AS sugar_g,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_a') AS vitamin_a_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_c') AS vitamin_c_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_d') AS vitamin_d_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_e') AS vitamin_e_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_k') AS vitamin_k_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b1') AS vitamin_b1_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b2') AS vitamin_b2_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b3') AS vitamin_b3_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b5') AS vitamin_b5_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b6') AS vitamin_b6_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b7') AS vitamin_b7_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b9') AS vitamin_b9_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'vitamin_b12') AS vitamin_b12_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calcium') AS calcium_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'iron') AS iron_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'magnesium') AS magnesium_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'zinc') AS zinc_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'selenium') AS selenium_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'copper') AS copper_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'manganese') AS manganese_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'chromium') AS chromium_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'iodine') AS iodine_mcg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'omega_3') AS omega3_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'omega_6') AS omega6_mg,
  max(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'caffeine') AS caffeine_mg,
  NULL::integer AS water_ml,
  definition.created_at,
  supplement.updated_at
FROM fitness.supplement AS supplement
INNER JOIN fitness.supplement_definition AS definition
  ON
    supplement.id = definition.supplement_id
    AND definition.effective_to IS NULL
LEFT JOIN fitness.supplement_definition_nutrient AS nutrient
  ON definition.id = nutrient.definition_id
GROUP BY supplement.id, definition.id;
--> statement-breakpoint

CREATE VIEW fitness.v_supplement_dose_current AS
SELECT
  event.id,
  event.user_id,
  event.supplement_id,
  event.definition_id,
  event.provider_id,
  event.external_id,
  event.scheduled_date,
  event.status,
  event.supersedes_event_id,
  event.recorded_at,
  event.source_name,
  event.raw,
  event.created_at
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
  AND classification.source_key = any(resolution.contributing_source_keys)
  AND classification.effective_grain = resolution.contribution_grain

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
  ON
    event.user_id = resolution.user_id
    AND event.scheduled_date = resolution.date
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
    array_agg(DISTINCT event.provider_id ORDER BY event.provider_id) AS provider_ids,
    array_agg(
      DISTINCT coalesce(nullif(btrim(event.source_name), ''), event.provider_id)
      ORDER BY coalesce(nullif(btrim(event.source_name), ''), event.provider_id)
    ) AS source_labels
  FROM fitness.v_supplement_dose_current AS event
  WHERE event.status = 'taken'
  GROUP BY event.user_id, event.scheduled_date
),

date_context AS (
  SELECT
    coalesce(resolution.user_id, supplement.user_id) AS user_id,
    coalesce(resolution.date, supplement.date) AS date,
    coalesce(resolution.resolution_status, 'available') AS resolution_status,
    CASE
      WHEN resolution.user_id IS NULL
        THEN 'Totals use explicitly taken supplement doses.'
      WHEN resolution.resolution_status = 'available' AND supplement.user_id IS NOT NULL
        THEN resolution.resolution_message || ' Explicitly taken supplement doses are included.'
      ELSE resolution.resolution_message
    END AS resolution_message,
    array(
      SELECT DISTINCT value
      FROM
        unnest(
          coalesce(resolution.source_providers, ARRAY[]::text [])
          || coalesce(supplement.provider_ids, ARRAY[]::text [])
        ) AS value
      ORDER BY value
    ) AS source_providers,
    array(
      SELECT DISTINCT value
      FROM
        unnest(
          coalesce(resolution.contributing_providers, ARRAY[]::text [])
          || CASE
            WHEN resolution.user_id IS NULL OR resolution.resolution_status = 'available'
              THEN coalesce(supplement.provider_ids, ARRAY[]::text [])
            ELSE ARRAY[]::text []
          END
        ) AS value
      ORDER BY value
    ) AS contributing_providers,
    array(
      SELECT DISTINCT value
      FROM
        unnest(
          coalesce(resolution.excluded_providers, ARRAY[]::text [])
          || CASE
            WHEN resolution.resolution_status = 'source_conflict'
              THEN coalesce(supplement.provider_ids, ARRAY[]::text [])
            ELSE ARRAY[]::text []
          END
        ) AS value
      ORDER BY value
    ) AS excluded_providers,
    array(
      SELECT DISTINCT value
      FROM
        unnest(
          coalesce(resolution.source_labels, ARRAY[]::text [])
          || coalesce(supplement.source_labels, ARRAY[]::text [])
        ) AS value
      ORDER BY value
    ) AS source_labels,
    array(
      SELECT DISTINCT value
      FROM
        unnest(
          coalesce(resolution.contributing_source_labels, ARRAY[]::text [])
          || CASE
            WHEN resolution.user_id IS NULL OR resolution.resolution_status = 'available'
              THEN coalesce(supplement.source_labels, ARRAY[]::text [])
            ELSE ARRAY[]::text []
          END
        ) AS value
      ORDER BY value
    ) AS contributing_source_labels,
    array(
      SELECT DISTINCT value
      FROM
        unnest(
          coalesce(resolution.excluded_source_labels, ARRAY[]::text [])
          || CASE
            WHEN resolution.resolution_status = 'source_conflict'
              THEN coalesce(supplement.source_labels, ARRAY[]::text [])
            ELSE ARRAY[]::text []
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
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'calories')::integer
  END AS calories,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'protein')
  END AS protein_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'carbohydrate')
  END AS carbs_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fat')
  END AS fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'saturated_fat')
  END AS saturated_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'polyunsaturated_fat')
  END AS polyunsaturated_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'monounsaturated_fat')
  END AS monounsaturated_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'trans_fat')
  END AS trans_fat_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'cholesterol')
  END AS cholesterol_mg,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sodium')
  END AS sodium_mg,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'potassium')
  END AS potassium_mg,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'fiber')
  END AS fiber_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'sugar')
  END AS sugar_g,
  CASE
    WHEN context.resolution_status = 'available'
      THEN sum(nutrient.amount) FILTER (WHERE nutrient.nutrient_id = 'water')::integer
  END AS water_ml,
  CASE
    WHEN context.resolution_status = 'available'
      THEN min(nutrient.created_at)
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
