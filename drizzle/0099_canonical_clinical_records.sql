DROP VIEW fitness.provider_stats;
--> statement-breakpoint
CREATE TABLE fitness.clinical_record (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
  provider_id text NOT NULL REFERENCES fitness.provider(id),
  external_id text NOT NULL,
  clinical_type text NOT NULL,
  display_name text NOT NULL,
  source_name text,
  fhir_version text NOT NULL,
  fhir jsonb NOT NULL,
  downloaded_at timestamptz NOT NULL,
  recorded_at timestamptz,
  issued_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX clinical_record_user_provider_external_idx
ON fitness.clinical_record (user_id, provider_id, external_id);
--> statement-breakpoint
INSERT INTO fitness.clinical_record (
  user_id,
  provider_id,
  external_id,
  clinical_type,
  display_name,
  source_name,
  fhir_version,
  fhir,
  downloaded_at,
  recorded_at,
  issued_at
)
SELECT
  user_id,
  provider_id,
  COALESCE(external_id, id::text),
  'labResult',
  name,
  source_name,
  'R4',
  COALESCE(
    raw,
    jsonb_strip_nulls(
      jsonb_build_object(
        'resourceType', 'DiagnosticReport',
        'id', COALESCE(external_id, id::text),
        'status', status,
        'code', jsonb_build_object('text', name),
        'effectiveDateTime', recorded_at,
        'issued', issued_at
      )
    )
  ),
  created_at,
  recorded_at,
  issued_at
FROM fitness.lab_panel;
--> statement-breakpoint
INSERT INTO fitness.clinical_record (
  user_id,
  provider_id,
  external_id,
  clinical_type,
  display_name,
  source_name,
  fhir_version,
  fhir,
  downloaded_at,
  recorded_at,
  issued_at
)
SELECT
  user_id,
  provider_id,
  COALESCE(external_id, id::text),
  'labResult',
  test_name,
  source_name,
  'R4',
  COALESCE(
    raw,
    jsonb_strip_nulls(
      jsonb_build_object(
        'resourceType', 'Observation',
        'id', COALESCE(external_id, id::text),
        'status', status,
        'code', jsonb_build_object('text', test_name),
        'valueQuantity', CASE
          WHEN value IS NULL AND unit IS NULL THEN NULL
          ELSE jsonb_strip_nulls(jsonb_build_object('value', value, 'unit', unit))
        END,
        'valueString', value_text,
        'effectiveDateTime', recorded_at,
        'issued', issued_at
      )
    )
  ),
  created_at,
  recorded_at,
  issued_at
FROM fitness.lab_result;
--> statement-breakpoint
INSERT INTO fitness.clinical_record (
  user_id,
  provider_id,
  external_id,
  clinical_type,
  display_name,
  source_name,
  fhir_version,
  fhir,
  downloaded_at,
  recorded_at
)
SELECT
  user_id,
  provider_id,
  COALESCE(external_id, id::text),
  'medication',
  name,
  source_name,
  'R4',
  COALESCE(
    raw,
    jsonb_strip_nulls(
      jsonb_build_object(
        'resourceType', 'MedicationRequest',
        'id', COALESCE(external_id, id::text),
        'status', status,
        'medicationReference', jsonb_build_object('display', name),
        'authoredOn', authored_on,
        'dosageInstruction', CASE
          WHEN dosage_text IS NULL AND route IS NULL THEN NULL
          ELSE jsonb_build_array(
            jsonb_strip_nulls(
              jsonb_build_object(
                'text', dosage_text,
                'route', CASE
                  WHEN route IS NULL THEN NULL
                  ELSE jsonb_build_object('text', route)
                END
              )
            )
          )
        END
      )
    )
  ),
  created_at,
  COALESCE(authored_on, start_date)::timestamp AT TIME ZONE 'UTC'
FROM fitness.medication;
--> statement-breakpoint
INSERT INTO fitness.clinical_record (
  user_id,
  provider_id,
  external_id,
  clinical_type,
  display_name,
  source_name,
  fhir_version,
  fhir,
  downloaded_at,
  recorded_at
)
SELECT
  user_id,
  provider_id,
  COALESCE(external_id, id::text),
  'condition',
  name,
  source_name,
  'R4',
  COALESCE(
    raw,
    jsonb_strip_nulls(
      jsonb_build_object(
        'resourceType', 'Condition',
        'id', COALESCE(external_id, id::text),
        'code', jsonb_build_object('text', name),
        'clinicalStatus', CASE
          WHEN clinical_status IS NULL THEN NULL
          ELSE jsonb_build_object('text', clinical_status)
        END,
        'verificationStatus', CASE
          WHEN verification_status IS NULL THEN NULL
          ELSE jsonb_build_object('text', verification_status)
        END,
        'onsetDateTime', onset_date,
        'abatementDateTime', abatement_date,
        'recordedDate', recorded_date
      )
    )
  ),
  created_at,
  COALESCE(recorded_date, onset_date)::timestamp AT TIME ZONE 'UTC'
FROM fitness.condition;
--> statement-breakpoint
INSERT INTO fitness.clinical_record (
  user_id,
  provider_id,
  external_id,
  clinical_type,
  display_name,
  source_name,
  fhir_version,
  fhir,
  downloaded_at,
  recorded_at
)
SELECT
  user_id,
  provider_id,
  COALESCE(external_id, id::text),
  'allergy',
  name,
  source_name,
  'R4',
  COALESCE(
    raw,
    jsonb_strip_nulls(
      jsonb_build_object(
        'resourceType', 'AllergyIntolerance',
        'id', COALESCE(external_id, id::text),
        'code', jsonb_build_object('text', name),
        'type', type,
        'clinicalStatus', CASE
          WHEN clinical_status IS NULL THEN NULL
          ELSE jsonb_build_object('text', clinical_status)
        END,
        'verificationStatus', CASE
          WHEN verification_status IS NULL THEN NULL
          ELSE jsonb_build_object('text', verification_status)
        END,
        'onsetDateTime', onset_date,
        'reaction', reactions
      )
    )
  ),
  created_at,
  onset_date::timestamp AT TIME ZONE 'UTC'
FROM fitness.allergy_intolerance;
--> statement-breakpoint
DROP TABLE fitness.lab_result;
DROP TABLE fitness.lab_panel;
DROP TABLE fitness.medication;
DROP TABLE fitness.condition;
DROP TABLE fitness.allergy_intolerance;
--> statement-breakpoint
CREATE OR REPLACE VIEW fitness.provider_stats AS
WITH providers AS (
  SELECT DISTINCT user_id, provider_id
  FROM fitness.oauth_token
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.activity WHERE provider_absent_at IS NULL AND deleted_at IS NULL
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.daily_metrics
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.sleep_session
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.food_entry
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.health_event
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.v_nutrition_provider_daily
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.clinical_record
  UNION
  SELECT DISTINCT user_id, provider_id FROM fitness.journal_entry
)
SELECT
  p.user_id,
  p.provider_id,
  COALESCE(a.cnt, 0)::bigint AS activities,
  COALESCE(dm.cnt, 0)::bigint AS daily_metrics,
  COALESCE(ss.cnt, 0)::bigint AS sleep_sessions,
  0::bigint AS body_measurements,
  COALESCE(fe.cnt, 0)::bigint AS food_entries,
  COALESCE(he.cnt, 0)::bigint AS health_events,
  0::bigint AS metric_stream,
  COALESCE(nd.cnt, 0)::bigint AS nutrition_daily,
  COALESCE(cr.cnt, 0)::bigint AS clinical_records,
  COALESCE(je.cnt, 0)::bigint AS journal_entries
FROM providers p
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.activity
  WHERE provider_absent_at IS NULL
    AND deleted_at IS NULL
  GROUP BY user_id, provider_id
) a ON a.user_id = p.user_id AND a.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.daily_metrics
  GROUP BY user_id, provider_id
) dm ON dm.user_id = p.user_id AND dm.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.sleep_session
  GROUP BY user_id, provider_id
) ss ON ss.user_id = p.user_id AND ss.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.food_entry
  WHERE confirmed = true
  GROUP BY user_id, provider_id
) fe ON fe.user_id = p.user_id AND fe.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.health_event
  GROUP BY user_id, provider_id
) he ON he.user_id = p.user_id AND he.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.v_nutrition_provider_daily
  GROUP BY user_id, provider_id
) nd ON nd.user_id = p.user_id AND nd.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.clinical_record
  GROUP BY user_id, provider_id
) cr ON cr.user_id = p.user_id AND cr.provider_id = p.provider_id
LEFT JOIN (
  SELECT user_id, provider_id, count(*) AS cnt
  FROM fitness.journal_entry
  GROUP BY user_id, provider_id
) je ON je.user_id = p.user_id AND je.provider_id = p.provider_id;
