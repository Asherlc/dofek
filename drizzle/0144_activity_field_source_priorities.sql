CREATE TABLE fitness.provider_field_priority (
  provider_id text NOT NULL,
  field_key text NOT NULL,
  priority integer NOT NULL,
  PRIMARY KEY (provider_id, field_key)
);
--> statement-breakpoint
ALTER TABLE fitness.provider_priority_audit ADD COLUMN field_key text;
--> statement-breakpoint
ALTER TABLE fitness.provider_priority_audit
DROP CONSTRAINT provider_priority_audit_priority_table_check;
--> statement-breakpoint
ALTER TABLE fitness.provider_priority_audit
ADD CONSTRAINT provider_priority_audit_priority_table_check CHECK (
  priority_table IN (
    'provider_priority',
    'device_priority',
    'sensor_provider_priority',
    'sensor_device_priority',
    'provider_field_priority'
  )
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fitness.record_provider_priority_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_provider_id text;
  changed_source_name_pattern text;
  changed_channel text;
  changed_field_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_provider_id := OLD.provider_id;
  ELSE
    changed_provider_id := NEW.provider_id;
  END IF;

  IF TG_TABLE_NAME IN ('device_priority', 'sensor_device_priority') THEN
    IF TG_OP = 'DELETE' THEN
      changed_source_name_pattern := OLD.source_name_pattern;
    ELSE
      changed_source_name_pattern := NEW.source_name_pattern;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('sensor_provider_priority', 'sensor_device_priority') THEN
    IF TG_OP = 'DELETE' THEN
      changed_channel := OLD.channel;
    ELSE
      changed_channel := NEW.channel;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'provider_field_priority' THEN
    IF TG_OP = 'DELETE' THEN
      changed_field_key := OLD.field_key;
    ELSE
      changed_field_key := NEW.field_key;
    END IF;
  END IF;

  INSERT INTO fitness.provider_priority_audit (
    changed_by,
    priority_table,
    provider_id,
    source_name_pattern,
    channel,
    field_key,
    old_value,
    new_value,
    reason
  )
  VALUES (
    COALESCE(NULLIF(current_setting('app.changed_by', true), ''), current_user),
    TG_TABLE_NAME,
    changed_provider_id,
    changed_source_name_pattern,
    changed_channel,
    changed_field_key,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    NULLIF(current_setting('app.priority_change_reason', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_field_priority_audit_trigger
AFTER INSERT OR UPDATE OR DELETE ON fitness.provider_field_priority
FOR EACH ROW EXECUTE FUNCTION fitness.record_provider_priority_audit();
--> statement-breakpoint
INSERT INTO fitness.provider_field_priority (provider_id, field_key, priority)
VALUES ('kaya', 'activity.name', 0);
--> statement-breakpoint
-- Canonical definition of the fitness.v_activity view.
-- This file is the source definition for fresh databases, local test schemas,
-- and future forward migrations that need to update the deployed view.
--
-- To change v_activity: edit THIS file and add a forward migration when the
-- deployed view definition must change.
-- Git merge conflicts here force developers to reconcile concurrent changes.

CREATE OR REPLACE VIEW fitness.v_activity AS
WITH apple_health_revisions AS (
  -- HealthKit replaces a workout by sync identifier even when its UUID and times change.
  -- Rank before lifecycle filtering so a removed latest revision cannot revive an older one.
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, TRIM(raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier')
      ORDER BY
        COALESCE(
          CASE
            WHEN (raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]{1,19}$'
              THEN CASE
                WHEN (raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::numeric <= 9223372036854775807
                  THEN (raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
                ELSE 0
              END
          END,
          0
        ) DESC,
        created_at DESC,
        id DESC
    ) AS revision_rank
  FROM fitness.activity
  WHERE
    provider_id = 'apple_health'
    AND NULLIF(TRIM(raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), '') IS NOT null
),

ranked AS (
  SELECT
    a.*,
    COALESCE(dp.priority, pp.priority, 100) AS prio,
    COALESCE(name_priority.priority, dp.priority, pp.priority, 100) AS name_prio,
    COALESCE(notes_priority.priority, dp.priority, pp.priority, 100) AS notes_prio,
    COALESCE(effort_priority.priority, dp.priority, pp.priority, 100) AS effort_prio,
    payload.complete_working_set_count,
    payload.set_count,
    payload.exercise_count
  FROM fitness.activity AS a
  LEFT JOIN fitness.provider_priority AS pp ON a.provider_id = pp.provider_id
  LEFT JOIN fitness.provider_field_priority AS name_priority
    ON a.provider_id = name_priority.provider_id AND name_priority.field_key = 'activity.name'
  LEFT JOIN fitness.provider_field_priority AS notes_priority
    ON a.provider_id = notes_priority.provider_id AND notes_priority.field_key = 'activity.notes'
  LEFT JOIN fitness.provider_field_priority AS effort_priority
    ON
      a.provider_id = effort_priority.provider_id
      AND effort_priority.field_key = 'activity.perceived_exertion'
  LEFT JOIN LATERAL (
    SELECT dp2.priority
    FROM fitness.device_priority AS dp2
    WHERE
      dp2.provider_id = a.provider_id
      AND a.source_name LIKE dp2.source_name_pattern
    ORDER BY LENGTH(dp2.source_name_pattern) DESC
    LIMIT 1
  ) AS dp ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (
        WHERE s.set_type = 'working'
        AND (
          s.weight_kg IS NOT null OR s.reps IS NOT null
          OR s.duration_seconds IS NOT null OR s.distance_meters IS NOT null
        )
      ) AS complete_working_set_count,
      COUNT(*) AS set_count,
      COUNT(DISTINCT s.exercise_id) AS exercise_count
    FROM fitness.strength_set AS s
    WHERE s.activity_id = a.id
  ) AS payload ON true
  WHERE
    a.provider_absent_at IS null
    AND a.deleted_at IS null
    AND a.id NOT IN (
      SELECT revisions.id FROM apple_health_revisions AS revisions
      WHERE revisions.revision_rank > 1
    )
),

tombstoned AS (
  SELECT
    a.id,
    a.user_id,
    a.provider_id,
    a.canonical_type,
    a.external_id,
    a.started_at,
    a.ended_at,
    a.provider_absent_at,
    COALESCE(
      NULLIF(TRIM(a.raw ->> 'sourceName'), ''),
      NULLIF(TRIM(a.source_name), '')
    ) AS subsource
  FROM fitness.activity AS a
  WHERE
    a.provider_absent_at IS NOT null
    AND a.deleted_at IS null
    AND a.external_id IS NOT null
    AND a.external_id <> ''
    AND a.id NOT IN (
      SELECT revisions.id FROM apple_health_revisions AS revisions
      WHERE revisions.revision_rank > 1
    )
),

effective_tombstoned AS (
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.canonical_type,
    t.external_id,
    t.started_at,
    t.ended_at,
    t.provider_absent_at,
    t.subsource
  FROM tombstoned AS t
  WHERE t.provider_id <> 'apple_health'
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.canonical_type,
    t.external_id,
    t.started_at,
    t.ended_at,
    t.provider_absent_at,
    t.subsource
  FROM tombstoned AS t
  INNER JOIN fitness.activity AS a ON t.id = a.id
  WHERE
    t.provider_id = 'apple_health'
    AND NOT EXISTS (
      SELECT 1
      FROM fitness.activity AS sib
      WHERE
        sib.user_id = a.user_id
        AND sib.provider_id = 'apple_health'
        AND sib.deleted_at IS null
        AND sib.id <> a.id
        AND sib.id NOT IN (
          SELECT revisions.id FROM apple_health_revisions AS revisions
          WHERE revisions.revision_rank > 1
        )
        AND COALESCE(
          NULLIF(TRIM(sib.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || sib.started_at::text || ':' || COALESCE(sib.ended_at::text, '') || ':' || COALESCE(
            NULLIF(TRIM(sib.raw ->> 'sourceName'), ''),
            NULLIF(TRIM(sib.source_name), ''),
            ''
          )
        ) = COALESCE(
          NULLIF(TRIM(a.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || a.started_at::text || ':' || COALESCE(a.ended_at::text, '') || ':' || COALESCE(
            NULLIF(TRIM(a.raw ->> 'sourceName'), ''),
            NULLIF(TRIM(a.source_name), ''),
            ''
          )
        )
        AND (
          sib.provider_absent_at IS null AND sib.deleted_at IS null
          OR COALESCE(
            CASE
              WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]{1,19}$'
                THEN CASE
                  WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::numeric <= 9223372036854775807
                    THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
                  ELSE 0
                END
            END,
            0
          ) > COALESCE(
            CASE
              WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]{1,19}$'
                THEN CASE
                  WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::numeric <= 9223372036854775807
                    THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
                  ELSE 0
                END
            END,
            0
          )
          OR (
            COALESCE(
              CASE
                WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]{1,19}$'
                  THEN CASE
                    WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::numeric <= 9223372036854775807
                      THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
                    ELSE 0
                  END
              END,
              0
            ) = COALESCE(
              CASE
                WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]{1,19}$'
                  THEN CASE
                    WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::numeric <= 9223372036854775807
                      THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
                    ELSE 0
                  END
              END,
              0
            )
            AND sib.created_at > a.created_at
          )
        )
    )
),

final_groups AS (
  SELECT
    r.id AS activity_id,
    r.group_id
  FROM ranked AS r
  UNION ALL
  SELECT
    t.id AS activity_id,
    a.group_id
  FROM effective_tombstoned AS t
  INNER JOIN fitness.activity AS a ON t.id = a.id
),

best_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.id AS canonical_id,
    r.provider_id,
    r.user_id,
    r.canonical_type,
    r.provider_type,
    r.modality,
    r.started_at,
    r.ended_at,
    r.source_name,
    r.prio
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  ORDER BY
    fg.group_id ASC,
    r.complete_working_set_count DESC,
    r.set_count DESC,
    r.exercise_count DESC,
    (r.canonical_type NOT IN ('cardio', 'other')) DESC,
    COALESCE(
      NULLIF(LOWER(TRIM(r.provider_type)), '') <> LOWER(r.canonical_type::text),
      false
    ) DESC,
    r.prio ASC,
    r.id ASC
),

best_context_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.timezone,
    r.start_utc_offset_minutes,
    r.end_utc_offset_minutes,
    r.local_time_source
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  ORDER BY
    fg.group_id ASC,
    CASE
      WHEN r.local_time_source = 'gps_timezone' THEN 1
      WHEN r.local_time_source IN (
        'provider_timezone',
        'device_timezone',
        'user_home_timezone'
      ) THEN 2
      -- Direct source evidence outranks a configured home-zone fallback for travel.
      WHEN r.local_time_source IN ('provider_offset', 'device_offset') THEN 3
      WHEN r.local_time_source = 'home_zone_fallback' THEN 4
      WHEN r.local_time_source = 'unknown' THEN 5
      ELSE 6
    END ASC,
    r.prio ASC,
    r.id ASC
),

group_bounds AS (
  SELECT
    fg.group_id,
    MIN(r.started_at) AS started_at,
    MAX(r.ended_at) AS ended_at
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  GROUP BY fg.group_id
),

absent_source_links AS (
  SELECT
    fg.group_id,
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'providerId', t.provider_id,
        'externalId', t.external_id,
        'memberActivityId', t.id::text,
        'providerAbsentAt', t.provider_absent_at,
        'subsource', t.subsource
      )
      ORDER BY t.provider_id, t.id
    ) AS absent_source_external_ids
  FROM final_groups AS fg
  INNER JOIN effective_tombstoned AS t ON fg.activity_id = t.id
  GROUP BY fg.group_id
),

tombstoned_groups AS (
  SELECT DISTINCT fg.group_id
  FROM final_groups AS fg
  INNER JOIN effective_tombstoned AS t ON fg.activity_id = t.id
),

merged AS (
  SELECT
    b.group_id,
    b.canonical_id,
    b.provider_id,
    b.user_id,
    b.canonical_type,
    b.provider_type,
    b.modality,
    bounds.started_at,
    bounds.ended_at,
    b.source_name,
    (
      SELECT r.perceived_exertion
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.perceived_exertion IS NOT null
      ORDER BY r.effort_prio ASC, r.id ASC LIMIT 1
    ) AS perceived_exertion,
    (
      SELECT r.name FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.name IS NOT null
      ORDER BY r.name_prio ASC, r.id ASC LIMIT 1
    ) AS name,
    (
      SELECT r.notes FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.notes IS NOT null
      ORDER BY r.notes_prio ASC, r.id ASC LIMIT 1
    ) AS notes,
    CASE
      WHEN context.local_time_source = 'unknown' THEN null
      ELSE context.timezone
    END AS timezone,
    context.start_utc_offset_minutes,
    context.end_utc_offset_minutes,
    context.local_time_source,
    (
      SELECT JSONB_OBJECT_AGG(sub.key, sub.value)
      FROM (
        SELECT
          raw_entry.key,
          raw_entry.value,
          ROW_NUMBER() OVER (PARTITION BY raw_entry.key ORDER BY r.prio ASC) AS rn
        FROM final_groups AS fg2
        INNER JOIN ranked AS r ON fg2.activity_id = r.id,
          LATERAL JSONB_EACH(COALESCE(r.raw, '{}'::jsonb)) AS raw_entry (key, value)
        WHERE fg2.group_id = b.group_id
      ) AS sub
      WHERE sub.rn = 1
    ) AS raw,
    (
      SELECT ARRAY_AGG(DISTINCT r.provider_id ORDER BY r.provider_id)
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id
    ) AS source_providers,
    (
      SELECT
        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'providerId', r.provider_id,
            'externalId', r.external_id,
            'memberActivityId', r.id::text,
            -- Preserve the per-member upstream app for grouped Apple Health rows.
            'subsource', COALESCE(
              NULLIF(TRIM(r.raw ->> 'sourceName'), ''),
              NULLIF(TRIM(r.source_name), '')
            )
          )
          ORDER BY r.provider_id
        )
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE
        fg2.group_id = b.group_id
        AND r.external_id IS NOT null
        AND r.external_id <> ''
    ) AS source_external_ids,
    (
      SELECT ARRAY_AGG(fg2.activity_id ORDER BY fg2.activity_id)
      FROM final_groups AS fg2
      WHERE fg2.group_id = b.group_id
    ) AS member_activity_ids,
    absent_source_links.absent_source_external_ids
  FROM best_per_group AS b
  INNER JOIN group_bounds AS bounds ON b.group_id = bounds.group_id
  INNER JOIN best_context_per_group AS context ON b.group_id = context.group_id
  LEFT JOIN absent_source_links ON b.group_id = absent_source_links.group_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tombstoned_groups AS tg
    WHERE tg.group_id = b.group_id
  )
)

SELECT
  m.group_id AS id,
  m.provider_id,
  m.user_id,
  m.canonical_id AS primary_activity_id,
  m.canonical_type,
  m.provider_type,
  m.modality,
  m.started_at,
  m.ended_at,
  m.source_name,
  m.name,
  m.notes,
  m.timezone,
  m.raw,
  m.source_providers,
  m.source_external_ids,
  m.member_activity_ids,
  m.absent_source_external_ids,
  m.start_utc_offset_minutes,
  m.end_utc_offset_minutes,
  COALESCE(m.local_time_source, 'unknown') AS local_time_source,
  m.perceived_exertion
FROM merged AS m
ORDER BY m.started_at DESC;
