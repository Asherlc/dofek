-- Replace the replicated activity relation atomically so PeerDB never observes a
-- partially transformed column contract. The replacement changes the relation
-- OID; deployers must resync the activity raw mirror after this migration.
LOCK TABLE fitness.activity IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE activity_migration_view_definitions ON COMMIT DROP AS
SELECT
  views.schemaname,
  views.viewname,
  views.definition,
  dependencies.recreation_order
FROM pg_views AS views
INNER JOIN (
  VALUES
  ('fitness', 'provider_stats', 1),
  ('fitness', 'v_activity_members', 2),
  ('clickhouse', 'v_activity_members', 3)
) AS dependencies (schemaname, viewname, recreation_order)
  ON
    views.schemaname = dependencies.schemaname
    AND views.viewname = dependencies.viewname;

DROP VIEW clickhouse.v_activity_members;
DROP VIEW fitness.v_activity_members;
DROP VIEW clickhouse.v_activity;
DROP VIEW clickhouse.activity;
DROP VIEW fitness.provider_stats;
DROP VIEW fitness.v_activity;

CREATE TEMP TABLE activity_inbound_foreign_keys ON COMMIT DROP AS
SELECT
  child_namespace.nspname AS child_schema,
  child_class.relname AS child_table,
  constraint_record.conname,
  pg_get_constraintdef(constraint_record.oid, true) AS definition,
  constraint_record.convalidated
FROM pg_constraint AS constraint_record
INNER JOIN pg_class AS child_class ON constraint_record.conrelid = child_class.oid
INNER JOIN pg_namespace AS child_namespace ON child_class.relnamespace = child_namespace.oid
WHERE
  constraint_record.contype = 'f'
  AND constraint_record.confrelid = 'fitness.activity'::regclass;

CREATE TEMP TABLE activity_constraints ON COMMIT DROP AS
SELECT
  constraint_record.conname,
  constraint_record.contype,
  pg_get_constraintdef(constraint_record.oid, true) AS definition,
  constraint_record.convalidated
FROM pg_constraint AS constraint_record
WHERE
  constraint_record.conrelid = 'fitness.activity'::regclass
  AND constraint_record.contype IN ('c', 'f', 'p', 'u');

CREATE TEMP TABLE activity_index_definitions ON COMMIT DROP AS
SELECT
  index_class.relname AS index_name,
  pg_get_indexdef(index_record.indexrelid) AS definition
FROM pg_index AS index_record
INNER JOIN pg_class AS index_class ON index_record.indexrelid = index_class.oid
WHERE
  index_record.indrelid = 'fitness.activity'::regclass
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.conindid = index_record.indexrelid
  );

CREATE TEMP TABLE activity_not_null_columns ON COMMIT DROP AS
SELECT attribute.attname AS column_name
FROM pg_attribute AS attribute
WHERE
  attribute.attrelid = 'fitness.activity'::regclass
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND attribute.attnotnull;

CREATE TEMP TABLE activity_column_defaults ON COMMIT DROP AS
SELECT
  column_name,
  column_default
FROM information_schema.columns
WHERE
  table_schema = 'fitness'
  AND table_name = 'activity'
  AND column_default IS NOT null;

CREATE TEMP TABLE activity_trigger_definitions ON COMMIT DROP AS
SELECT
  trigger_record.tgname AS trigger_name,
  pg_get_triggerdef(trigger_record.oid, true) AS definition,
  trigger_record.tgenabled
FROM pg_trigger AS trigger_record
WHERE
  trigger_record.tgrelid = 'fitness.activity'::regclass
  AND NOT trigger_record.tgisinternal;

CREATE TEMP TABLE activity_comments ON COMMIT DROP AS
SELECT
  attribute.attname AS column_name,
  description.description
FROM pg_description AS description
LEFT JOIN pg_attribute AS attribute
  ON
    description.objoid = attribute.attrelid
    AND description.objsubid = attribute.attnum
WHERE
  description.objoid = 'fitness.activity'::regclass;

CREATE TEMP TABLE activity_grants ON COMMIT DROP AS
SELECT
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'fitness' AND table_name = 'activity';

CREATE TEMP TABLE activity_publications ON COMMIT DROP AS
SELECT publication.pubname
FROM pg_publication AS publication
WHERE
  NOT publication.puballtables
  AND EXISTS (
    SELECT 1
    FROM pg_publication_tables AS publication_table
    WHERE
      publication_table.pubname = publication.pubname
      AND publication_table.schemaname = 'fitness'
      AND publication_table.tablename = 'activity'
  );

DO $$
DECLARE
  foreign_key_record record;
BEGIN
  FOR foreign_key_record IN SELECT * FROM activity_inbound_foreign_keys LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      foreign_key_record.child_schema,
      foreign_key_record.child_table,
      foreign_key_record.conname
    );
  END LOOP;
END
$$;

CREATE TYPE fitness.canonical_activity_type AS ENUM (
  'cycling',
  'running',
  'swimming',
  'walking',
  'hiking',
  'strength',
  'yoga',
  'pilates',
  'tai_chi',
  'mind_and_body',
  'meditation',
  'breathwork',
  'stretching',
  'barre',
  'elliptical',
  'rowing',
  'cardio',
  'hiit',
  'stair_climbing',
  'step_training',
  'jump_rope',
  'fitness_gaming',
  'cross_training',
  'bootcamp',
  'circuit_training',
  'core',
  'boxing',
  'kickboxing',
  'martial_arts',
  'group_exercise',
  'skiing',
  'snowboarding',
  'snow_sports',
  'snowshoeing',
  'skating',
  'surfing',
  'kayaking',
  'sailing',
  'paddling',
  'water_fitness',
  'water_polo',
  'water_sports',
  'diving',
  'snorkeling',
  'tennis',
  'table_tennis',
  'squash',
  'racquetball',
  'badminton',
  'pickleball',
  'padel',
  'basketball',
  'soccer',
  'american_football',
  'australian_football',
  'gaelic_football',
  'rugby',
  'hockey',
  'lacrosse',
  'baseball',
  'softball',
  'volleyball',
  'cricket',
  'handball',
  'golf',
  'disc_golf',
  'climbing',
  'dance',
  'triathlon',
  'multisport',
  'disc_sports',
  'equestrian',
  'fencing',
  'fishing',
  'hunting',
  'gymnastics',
  'archery',
  'bowling',
  'curling',
  'wrestling',
  'track_and_field',
  'play',
  'navigation',
  'geocaching',
  'skydiving',
  'paragliding',
  'preparation_and_recovery',
  'transition',
  'other'
);

CREATE TYPE fitness.activity_modality AS ENUM (
  'road',
  'mountain',
  'gravel',
  'indoor',
  'virtual',
  'electric',
  'cyclocross',
  'track',
  'bmx',
  'trail',
  'open_water',
  'functional',
  'mixed',
  'mixed_metabolic',
  'cross_country',
  'downhill',
  'paddleboard',
  'ice',
  'cardio',
  'social',
  'hand_cycle',
  'wheelchair',
  'cooldown'
);

CREATE TABLE fitness.activity_next AS
SELECT
  id,
  provider_id,
  user_id,
  external_id,
  activity_type::text AS provider_type,
  CASE
    WHEN activity_type::text IN ('cycling', 'road_cycling', 'mountain_biking', 'gravel_cycling', 'indoor_cycling', 'virtual_cycling', 'e_bike_cycling', 'cyclocross', 'track_cycling', 'bmx', 'hand_cycling') THEN 'cycling'
    WHEN activity_type::text IN ('running', 'trail_running', 'wheelchair_run') THEN 'running'
    WHEN activity_type::text IN ('swimming', 'open_water_swimming') THEN 'swimming'
    WHEN activity_type::text IN ('walking', 'wheelchair_walk') THEN 'walking'
    WHEN activity_type::text = 'hiking' THEN 'hiking'
    WHEN activity_type::text IN ('strength', 'strength_training', 'functional_strength', 'functional_fitness', 'gym') THEN 'strength'
    WHEN activity_type::text = 'yoga' THEN 'yoga'
    WHEN activity_type::text = 'pilates' THEN 'pilates'
    WHEN activity_type::text = 'tai_chi' THEN 'tai_chi'
    WHEN activity_type::text = 'mind_and_body' THEN 'mind_and_body'
    WHEN activity_type::text = 'meditation' THEN 'meditation'
    WHEN activity_type::text = 'breathwork' THEN 'breathwork'
    WHEN activity_type::text IN ('stretching', 'flexibility') THEN 'stretching'
    WHEN activity_type::text = 'barre' THEN 'barre'
    WHEN activity_type::text = 'elliptical' THEN 'elliptical'
    WHEN activity_type::text = 'rowing' THEN 'rowing'
    WHEN activity_type::text IN ('cardio', 'mixed_cardio', 'mixed_metabolic_cardio') THEN 'cardio'
    WHEN activity_type::text = 'hiit' THEN 'hiit'
    WHEN activity_type::text IN ('stair_climbing', 'stairmaster', 'stairs') THEN 'stair_climbing'
    WHEN activity_type::text = 'step_training' THEN 'step_training'
    WHEN activity_type::text = 'jump_rope' THEN 'jump_rope'
    WHEN activity_type::text = 'fitness_gaming' THEN 'fitness_gaming'
    WHEN activity_type::text = 'cross_training' THEN 'cross_training'
    WHEN activity_type::text = 'bootcamp' THEN 'bootcamp'
    WHEN activity_type::text = 'circuit_training' THEN 'circuit_training'
    WHEN activity_type::text IN ('core', 'core_training') THEN 'core'
    WHEN activity_type::text = 'boxing' THEN 'boxing'
    WHEN activity_type::text = 'kickboxing' THEN 'kickboxing'
    WHEN activity_type::text = 'martial_arts' THEN 'martial_arts'
    WHEN activity_type::text = 'group_exercise' THEN 'group_exercise'
    WHEN activity_type::text IN ('skiing', 'cross_country_skiing', 'downhill_skiing') THEN 'skiing'
    WHEN activity_type::text = 'snowboarding' THEN 'snowboarding'
    WHEN activity_type::text = 'snow_sports' THEN 'snow_sports'
    WHEN activity_type::text = 'snowshoeing' THEN 'snowshoeing'
    WHEN activity_type::text = 'skating' THEN 'skating'
    WHEN activity_type::text = 'surfing' THEN 'surfing'
    WHEN activity_type::text = 'kayaking' THEN 'kayaking'
    WHEN activity_type::text = 'sailing' THEN 'sailing'
    WHEN activity_type::text IN ('paddle_sports', 'paddleboarding', 'paddling') THEN 'paddling'
    WHEN activity_type::text IN ('water_fitness', 'aqua_fitness') THEN 'water_fitness'
    WHEN activity_type::text = 'water_polo' THEN 'water_polo'
    WHEN activity_type::text = 'water_sports' THEN 'water_sports'
    WHEN activity_type::text IN ('underwater_diving', 'diving') THEN 'diving'
    WHEN activity_type::text = 'snorkeling' THEN 'snorkeling'
    WHEN activity_type::text = 'tennis' THEN 'tennis'
    WHEN activity_type::text = 'table_tennis' THEN 'table_tennis'
    WHEN activity_type::text = 'squash' THEN 'squash'
    WHEN activity_type::text = 'racquetball' THEN 'racquetball'
    WHEN activity_type::text = 'badminton' THEN 'badminton'
    WHEN activity_type::text IN ('pickleball', 'paddle_racquet') THEN 'pickleball'
    WHEN activity_type::text = 'padel' THEN 'padel'
    WHEN activity_type::text = 'basketball' THEN 'basketball'
    WHEN activity_type::text = 'soccer' THEN 'soccer'
    WHEN activity_type::text IN ('football', 'american_football') THEN 'american_football'
    WHEN activity_type::text = 'australian_football' THEN 'australian_football'
    WHEN activity_type::text = 'rugby' THEN 'rugby'
    WHEN activity_type::text IN ('hockey', 'ice_hockey') THEN 'hockey'
    WHEN activity_type::text = 'lacrosse' THEN 'lacrosse'
    WHEN activity_type::text = 'baseball' THEN 'baseball'
    WHEN activity_type::text = 'softball' THEN 'softball'
    WHEN activity_type::text = 'volleyball' THEN 'volleyball'
    WHEN activity_type::text = 'cricket' THEN 'cricket'
    WHEN activity_type::text = 'handball' THEN 'handball'
    WHEN activity_type::text = 'golf' THEN 'golf'
    WHEN activity_type::text = 'disc_golf' THEN 'disc_golf'
    WHEN activity_type::text IN ('climbing', 'rock_climbing') THEN 'climbing'
    WHEN activity_type::text IN ('dance', 'dancing', 'cardio_dance', 'social_dance') THEN 'dance'
    WHEN activity_type::text = 'triathlon' THEN 'triathlon'
    WHEN activity_type::text = 'multisport' THEN 'multisport'
    WHEN activity_type::text = 'disc_sports' THEN 'disc_sports'
    WHEN activity_type::text = 'equestrian' THEN 'equestrian'
    WHEN activity_type::text = 'fencing' THEN 'fencing'
    WHEN activity_type::text = 'fishing' THEN 'fishing'
    WHEN activity_type::text = 'hunting' THEN 'hunting'
    WHEN activity_type::text = 'gymnastics' THEN 'gymnastics'
    WHEN activity_type::text = 'archery' THEN 'archery'
    WHEN activity_type::text = 'bowling' THEN 'bowling'
    WHEN activity_type::text = 'curling' THEN 'curling'
    WHEN activity_type::text = 'wrestling' THEN 'wrestling'
    WHEN activity_type::text = 'track_and_field' THEN 'track_and_field'
    WHEN activity_type::text = 'play' THEN 'play'
    WHEN activity_type::text = 'navigation' THEN 'navigation'
    WHEN activity_type::text = 'geocaching' THEN 'geocaching'
    WHEN activity_type::text = 'skydiving' THEN 'skydiving'
    WHEN activity_type::text = 'paragliding' THEN 'paragliding'
    WHEN activity_type::text IN ('preparation_and_recovery', 'cooldown') THEN 'preparation_and_recovery'
    WHEN activity_type::text = 'transition' THEN 'transition'
    WHEN activity_type::text = 'other' THEN 'other'
  END::fitness.canonical_activity_type AS canonical_type,
  CASE activity_type::text
    WHEN 'road_cycling' THEN 'road'
    WHEN 'mountain_biking' THEN 'mountain'
    WHEN 'gravel_cycling' THEN 'gravel'
    WHEN 'indoor_cycling' THEN 'indoor'
    WHEN 'virtual_cycling' THEN 'virtual'
    WHEN 'e_bike_cycling' THEN 'electric'
    WHEN 'cyclocross' THEN 'cyclocross'
    WHEN 'track_cycling' THEN 'track'
    WHEN 'bmx' THEN 'bmx'
    WHEN 'trail_running' THEN 'trail'
    WHEN 'open_water_swimming' THEN 'open_water'
    WHEN 'functional_strength' THEN 'functional'
    WHEN 'functional_fitness' THEN 'functional'
    WHEN 'mixed_cardio' THEN 'mixed'
    WHEN 'mixed_metabolic_cardio' THEN 'mixed_metabolic'
    WHEN 'cross_country_skiing' THEN 'cross_country'
    WHEN 'downhill_skiing' THEN 'downhill'
    WHEN 'paddleboarding' THEN 'paddleboard'
    WHEN 'ice_hockey' THEN 'ice'
    WHEN 'cardio_dance' THEN 'cardio'
    WHEN 'social_dance' THEN 'social'
    WHEN 'hand_cycling' THEN 'hand_cycle'
    WHEN 'wheelchair_walk' THEN 'wheelchair'
    WHEN 'wheelchair_run' THEN 'wheelchair'
    WHEN 'cooldown' THEN 'cooldown'
  END::fitness.activity_modality AS modality,
  started_at,
  ended_at,
  name,
  notes,
  perceived_exertion,
  source_name,
  timezone,
  start_utc_offset_minutes,
  end_utc_offset_minutes,
  local_time_source,
  strava_id,
  raw,
  provider_absent_at,
  deleted_at,
  created_at
FROM fitness.activity;

ALTER TABLE fitness.activity RENAME TO activity_legacy;
ALTER TABLE fitness.activity_next RENAME TO activity;
DROP TABLE fitness.activity_legacy;

DO $$
DECLARE
  constraint_record record;
  constraint_definition text;
BEGIN
  FOR constraint_record IN SELECT * FROM activity_constraints LOOP
    constraint_definition := constraint_record.definition;
    IF NOT constraint_record.convalidated THEN
      constraint_definition := constraint_definition || ' NOT VALID';
    END IF;
    EXECUTE format(
      'ALTER TABLE fitness.activity ADD CONSTRAINT %I %s',
      constraint_record.conname,
      constraint_definition
    );
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_not_null_columns LOOP
    EXECUTE format(
      'ALTER TABLE fitness.activity ALTER COLUMN %I SET NOT NULL',
      CASE WHEN constraint_record.column_name = 'activity_type' THEN 'provider_type' ELSE constraint_record.column_name END
    );
  END LOOP;

  ALTER TABLE fitness.activity ALTER COLUMN canonical_type SET NOT NULL;

  FOR constraint_record IN SELECT * FROM activity_column_defaults LOOP
    EXECUTE format(
      'ALTER TABLE fitness.activity ALTER COLUMN %I SET DEFAULT %s',
      CASE WHEN constraint_record.column_name = 'activity_type' THEN 'provider_type' ELSE constraint_record.column_name END,
      constraint_record.column_default
    );
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_index_definitions LOOP
    EXECUTE constraint_record.definition;
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_trigger_definitions LOOP
    EXECUTE constraint_record.definition;
    IF constraint_record.tgenabled = 'D' THEN
      EXECUTE format('ALTER TABLE fitness.activity DISABLE TRIGGER %I', constraint_record.trigger_name);
    ELSIF constraint_record.tgenabled = 'R' THEN
      EXECUTE format('ALTER TABLE fitness.activity ENABLE REPLICA TRIGGER %I', constraint_record.trigger_name);
    ELSIF constraint_record.tgenabled = 'A' THEN
      EXECUTE format('ALTER TABLE fitness.activity ENABLE ALWAYS TRIGGER %I', constraint_record.trigger_name);
    END IF;
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_comments LOOP
    IF constraint_record.column_name IS NULL THEN
      EXECUTE format('COMMENT ON TABLE fitness.activity IS %L', constraint_record.description);
    ELSE
      EXECUTE format('COMMENT ON COLUMN fitness.activity.%I IS %L', constraint_record.column_name, constraint_record.description);
    END IF;
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_grants LOOP
    EXECUTE format(
      'GRANT %s ON TABLE fitness.activity TO %s%s',
      constraint_record.privilege_type,
      CASE WHEN constraint_record.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(constraint_record.grantee) END,
      CASE WHEN constraint_record.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_publications LOOP
    EXECUTE format('ALTER PUBLICATION %I ADD TABLE fitness.activity', constraint_record.pubname);
  END LOOP;

  FOR constraint_record IN SELECT * FROM activity_inbound_foreign_keys LOOP
    constraint_definition := constraint_record.definition;
    IF NOT constraint_record.convalidated THEN
      constraint_definition := constraint_definition || ' NOT VALID';
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
      constraint_record.child_schema,
      constraint_record.child_table,
      constraint_record.conname,
      constraint_definition
    );
  END LOOP;
END
$$;

DROP TYPE fitness.activity_type;

CREATE OR REPLACE VIEW fitness.v_activity AS
WITH RECURSIVE ranked AS (
  SELECT
    a.*,
    coalesce(dp.priority, pp.priority, 100) AS prio
  FROM fitness.activity AS a
  LEFT JOIN fitness.provider_priority AS pp ON a.provider_id = pp.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.priority
    FROM fitness.device_priority AS dp2
    WHERE
      dp2.provider_id = a.provider_id
      AND a.source_name LIKE dp2.source_name_pattern
    ORDER BY length(dp2.source_name_pattern) DESC
    LIMIT 1
  ) AS dp ON true
  WHERE
    a.provider_absent_at IS null
    AND a.deleted_at IS null
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
    coalesce(
      nullif(trim(a.raw ->> 'sourceName'), ''),
      nullif(trim(a.source_name), '')
    ) AS subsource
  FROM fitness.activity AS a
  WHERE
    a.provider_absent_at IS NOT null
    AND a.deleted_at IS null
    AND a.external_id IS NOT null
    AND a.external_id <> ''
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
        AND coalesce(
          nullif(trim(sib.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || sib.started_at::text || ':' || coalesce(sib.ended_at::text, '') || ':' || coalesce(
            nullif(trim(sib.raw ->> 'sourceName'), ''),
            nullif(trim(sib.source_name), ''),
            ''
          )
        ) = coalesce(
          nullif(trim(a.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || a.started_at::text || ':' || coalesce(a.ended_at::text, '') || ':' || coalesce(
            nullif(trim(a.raw ->> 'sourceName'), ''),
            nullif(trim(a.source_name), ''),
            ''
          )
        )
        AND (
          sib.provider_absent_at IS null AND sib.deleted_at IS null
          OR coalesce(
            CASE
              WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
            END,
            0
          ) > coalesce(
            CASE
              WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
            END,
            0
          )
          OR (
            coalesce(
              CASE
                WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
              END,
              0
            ) = coalesce(
              CASE
                WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
              END,
              0
            )
            AND sib.created_at > a.created_at
          )
        )
    )
),

clusterable AS (
  SELECT
    r.id,
    r.user_id,
    r.provider_id,
    r.canonical_type,
    r.started_at,
    coalesce(r.ended_at, r.started_at + interval '1 hour') AS ended_at
  FROM ranked AS r
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.canonical_type,
    t.started_at,
    coalesce(t.ended_at, t.started_at + interval '1 hour') AS ended_at
  FROM effective_tombstoned AS t
),

pair_metrics AS (
  SELECT
    c1.id AS id1,
    c2.id AS id2,
    c1.provider_id AS provider_id1,
    c2.provider_id AS provider_id2,
    c1.canonical_type AS canonical_type1,
    c2.canonical_type AS canonical_type2,
    extract(EPOCH FROM (
      least(c1.ended_at, c2.ended_at) - greatest(c1.started_at, c2.started_at)
    )) AS overlap_seconds,
    extract(EPOCH FROM (
      greatest(c1.ended_at, c2.ended_at) - least(c1.started_at, c2.started_at)
    )) AS union_seconds,
    least(
      extract(EPOCH FROM (c1.ended_at - c1.started_at)),
      extract(EPOCH FROM (c2.ended_at - c2.started_at))
    ) AS shorter_duration_seconds
  FROM clusterable AS c1
  INNER JOIN clusterable AS c2
    ON
      c1.user_id = c2.user_id
      AND c1.id < c2.id
      AND c1.started_at < c2.ended_at
      AND c1.ended_at > c2.started_at
),

pairs AS (
  SELECT
    id1,
    id2
  FROM pair_metrics
  WHERE
    overlap_seconds / nullif(union_seconds, 0) > 0.8
    OR (
      provider_id1 <> provider_id2
      AND canonical_type1 = canonical_type2
      AND overlap_seconds / nullif(shorter_duration_seconds, 0) > 0.8
    )
),

edges AS (
  SELECT
    id1 AS a,
    id2 AS b
  FROM pairs
  UNION ALL
  SELECT
    id2 AS a,
    id1 AS b
  FROM pairs
),

clusters (activity_id, group_id, depth) AS (
  SELECT
    id,
    id::text,
    0
  FROM clusterable
  UNION
  SELECT
    e.b,
    c.group_id,
    c.depth + 1
  FROM edges AS e
  INNER JOIN clusters AS c ON e.a = c.activity_id
  WHERE c.depth < 2
),

final_groups AS (
  SELECT
    activity_id,
    min(group_id) AS group_id
  FROM clusters
  GROUP BY activity_id
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
  ORDER BY fg.group_id ASC, r.prio ASC, r.id ASC
),

group_bounds AS (
  SELECT
    fg.group_id,
    min(r.started_at) AS started_at,
    max(r.ended_at) AS ended_at
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  GROUP BY fg.group_id
),

absent_source_links AS (
  SELECT
    fg.group_id,
    jsonb_agg(
      jsonb_build_object(
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
      SELECT r.name FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.name IS NOT null
      ORDER BY r.prio ASC LIMIT 1
    ) AS name,
    (
      SELECT r.notes FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.notes IS NOT null
      ORDER BY r.prio ASC LIMIT 1
    ) AS notes,
    (
      SELECT r.timezone FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.timezone IS NOT null
      ORDER BY r.prio ASC LIMIT 1
    ) AS timezone,
    (
      SELECT jsonb_object_agg(sub.key, sub.value)
      FROM (
        SELECT
          raw_entry.key,
          raw_entry.value,
          row_number() OVER (PARTITION BY raw_entry.key ORDER BY r.prio ASC) AS rn
        FROM final_groups AS fg2
        INNER JOIN ranked AS r ON fg2.activity_id = r.id,
          LATERAL jsonb_each(coalesce(r.raw, '{}'::jsonb)) AS raw_entry
        WHERE fg2.group_id = b.group_id
      ) AS sub
      WHERE sub.rn = 1
    ) AS raw,
    (
      SELECT array_agg(DISTINCT r.provider_id ORDER BY r.provider_id)
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id
    ) AS source_providers,
    (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'providerId', r.provider_id,
            'externalId', r.external_id,
            'memberActivityId', r.id::text,
            -- Preserve the per-member upstream app for grouped Apple Health rows.
            'subsource', coalesce(
              nullif(trim(r.raw ->> 'sourceName'), ''),
              nullif(trim(r.source_name), '')
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
      SELECT array_agg(fg2.activity_id ORDER BY fg2.activity_id)
      FROM final_groups AS fg2
      WHERE fg2.group_id = b.group_id
    ) AS member_activity_ids,
    absent_source_links.absent_source_external_ids
  FROM best_per_group AS b
  INNER JOIN group_bounds AS bounds ON b.group_id = bounds.group_id
  LEFT JOIN absent_source_links ON b.group_id = absent_source_links.group_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tombstoned_groups AS tg
    WHERE tg.group_id = b.group_id
  )
)

SELECT
  m.canonical_id AS id,
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
  m.absent_source_external_ids
FROM merged AS m
ORDER BY m.started_at DESC;

CREATE VIEW clickhouse.activity AS
SELECT
  id,
  user_id,
  provider_id,
  canonical_type,
  provider_type,
  modality,
  name,
  started_at,
  ended_at,
  source_name
FROM fitness.activity;

CREATE VIEW clickhouse.v_activity AS
SELECT
  id,
  user_id,
  canonical_type,
  provider_type,
  modality,
  name,
  started_at,
  ended_at
FROM fitness.v_activity;

DO $$
DECLARE
  view_record record;
BEGIN
  FOR view_record IN
    SELECT
      views.schemaname,
      views.viewname,
      views.definition
    FROM activity_migration_view_definitions AS views
    ORDER BY views.recreation_order
  LOOP
    EXECUTE format(
      'CREATE VIEW %I.%I AS %s',
      view_record.schemaname,
      view_record.viewname,
      view_record.definition
    );
  END LOOP;
END
$$;
