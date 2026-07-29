-- Materialize canonical activity fields without replacing the replicated table.
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

ALTER TABLE fitness.activity
RENAME COLUMN activity_type TO provider_type;

ALTER TABLE fitness.activity
ALTER COLUMN provider_type TYPE text
USING provider_type::text;

ALTER TABLE fitness.activity
ADD COLUMN canonical_type fitness.canonical_activity_type
GENERATED ALWAYS AS (
  CASE
    WHEN provider_type::text IN (
      'cycling',
      'road_cycling',
      'mountain_biking',
      'gravel_cycling',
      'indoor_cycling',
      'virtual_cycling',
      'e_bike_cycling',
      'cyclocross',
      'track_cycling',
      'bmx',
      'hand_cycling'
    ) THEN 'cycling'
    WHEN provider_type::text IN ('running', 'trail_running', 'wheelchair_run') THEN 'running'
    WHEN provider_type::text IN ('swimming', 'open_water_swimming') THEN 'swimming'
    WHEN provider_type::text IN ('walking', 'wheelchair_walk') THEN 'walking'
    WHEN provider_type::text = 'hiking' THEN 'hiking'
    WHEN provider_type::text IN (
      'strength',
      'strength_training',
      'functional_strength',
      'functional_fitness',
      'gym'
    ) THEN 'strength'
    WHEN provider_type::text = 'yoga' THEN 'yoga'
    WHEN provider_type::text = 'pilates' THEN 'pilates'
    WHEN provider_type::text = 'tai_chi' THEN 'tai_chi'
    WHEN provider_type::text = 'mind_and_body' THEN 'mind_and_body'
    WHEN provider_type::text = 'meditation' THEN 'meditation'
    WHEN provider_type::text = 'breathwork' THEN 'breathwork'
    WHEN provider_type::text IN ('stretching', 'flexibility') THEN 'stretching'
    WHEN provider_type::text = 'barre' THEN 'barre'
    WHEN provider_type::text = 'elliptical' THEN 'elliptical'
    WHEN provider_type::text = 'rowing' THEN 'rowing'
    WHEN provider_type::text IN ('cardio', 'mixed_cardio', 'mixed_metabolic_cardio') THEN 'cardio'
    WHEN provider_type::text = 'hiit' THEN 'hiit'
    WHEN provider_type::text IN ('stair_climbing', 'stairmaster', 'stairs') THEN 'stair_climbing'
    WHEN provider_type::text = 'step_training' THEN 'step_training'
    WHEN provider_type::text = 'jump_rope' THEN 'jump_rope'
    WHEN provider_type::text = 'fitness_gaming' THEN 'fitness_gaming'
    WHEN provider_type::text = 'cross_training' THEN 'cross_training'
    WHEN provider_type::text = 'bootcamp' THEN 'bootcamp'
    WHEN provider_type::text = 'circuit_training' THEN 'circuit_training'
    WHEN provider_type::text IN ('core', 'core_training') THEN 'core'
    WHEN provider_type::text = 'boxing' THEN 'boxing'
    WHEN provider_type::text = 'kickboxing' THEN 'kickboxing'
    WHEN provider_type::text = 'martial_arts' THEN 'martial_arts'
    WHEN provider_type::text = 'group_exercise' THEN 'group_exercise'
    WHEN provider_type::text IN ('skiing', 'cross_country_skiing', 'downhill_skiing') THEN 'skiing'
    WHEN provider_type::text = 'snowboarding' THEN 'snowboarding'
    WHEN provider_type::text = 'snow_sports' THEN 'snow_sports'
    WHEN provider_type::text = 'snowshoeing' THEN 'snowshoeing'
    WHEN provider_type::text = 'skating' THEN 'skating'
    WHEN provider_type::text = 'surfing' THEN 'surfing'
    WHEN provider_type::text = 'kayaking' THEN 'kayaking'
    WHEN provider_type::text = 'sailing' THEN 'sailing'
    WHEN provider_type::text IN ('paddle_sports', 'paddleboarding', 'paddling') THEN 'paddling'
    WHEN provider_type::text IN ('water_fitness', 'aqua_fitness') THEN 'water_fitness'
    WHEN provider_type::text = 'water_polo' THEN 'water_polo'
    WHEN provider_type::text = 'water_sports' THEN 'water_sports'
    WHEN provider_type::text IN ('underwater_diving', 'diving') THEN 'diving'
    WHEN provider_type::text = 'snorkeling' THEN 'snorkeling'
    WHEN provider_type::text = 'tennis' THEN 'tennis'
    WHEN provider_type::text = 'table_tennis' THEN 'table_tennis'
    WHEN provider_type::text = 'squash' THEN 'squash'
    WHEN provider_type::text = 'racquetball' THEN 'racquetball'
    WHEN provider_type::text = 'badminton' THEN 'badminton'
    WHEN provider_type::text IN ('pickleball', 'paddle_racquet') THEN 'pickleball'
    WHEN provider_type::text = 'padel' THEN 'padel'
    WHEN provider_type::text = 'basketball' THEN 'basketball'
    WHEN provider_type::text = 'soccer' THEN 'soccer'
    WHEN provider_type::text IN ('football', 'american_football') THEN 'american_football'
    WHEN provider_type::text = 'australian_football' THEN 'australian_football'
    WHEN provider_type::text = 'rugby' THEN 'rugby'
    WHEN provider_type::text IN ('hockey', 'ice_hockey') THEN 'hockey'
    WHEN provider_type::text = 'lacrosse' THEN 'lacrosse'
    WHEN provider_type::text = 'baseball' THEN 'baseball'
    WHEN provider_type::text = 'softball' THEN 'softball'
    WHEN provider_type::text = 'volleyball' THEN 'volleyball'
    WHEN provider_type::text = 'cricket' THEN 'cricket'
    WHEN provider_type::text = 'handball' THEN 'handball'
    WHEN provider_type::text = 'golf' THEN 'golf'
    WHEN provider_type::text = 'disc_golf' THEN 'disc_golf'
    WHEN provider_type::text IN ('climbing', 'rock_climbing') THEN 'climbing'
    WHEN provider_type::text IN ('dance', 'dancing', 'cardio_dance', 'social_dance') THEN 'dance'
    WHEN provider_type::text = 'triathlon' THEN 'triathlon'
    WHEN provider_type::text = 'multisport' THEN 'multisport'
    WHEN provider_type::text = 'disc_sports' THEN 'disc_sports'
    WHEN provider_type::text = 'equestrian' THEN 'equestrian'
    WHEN provider_type::text = 'fencing' THEN 'fencing'
    WHEN provider_type::text = 'fishing' THEN 'fishing'
    WHEN provider_type::text = 'hunting' THEN 'hunting'
    WHEN provider_type::text = 'gymnastics' THEN 'gymnastics'
    WHEN provider_type::text = 'archery' THEN 'archery'
    WHEN provider_type::text = 'bowling' THEN 'bowling'
    WHEN provider_type::text = 'curling' THEN 'curling'
    WHEN provider_type::text = 'wrestling' THEN 'wrestling'
    WHEN provider_type::text = 'track_and_field' THEN 'track_and_field'
    WHEN provider_type::text = 'play' THEN 'play'
    WHEN provider_type::text = 'navigation' THEN 'navigation'
    WHEN provider_type::text = 'geocaching' THEN 'geocaching'
    WHEN provider_type::text = 'skydiving' THEN 'skydiving'
    WHEN provider_type::text = 'paragliding' THEN 'paragliding'
    WHEN provider_type::text IN ('preparation_and_recovery', 'cooldown') THEN 'preparation_and_recovery'
    WHEN provider_type::text = 'transition' THEN 'transition'
    WHEN provider_type::text = 'other' THEN 'other'
  END::fitness.canonical_activity_type
) STORED,
ADD COLUMN modality fitness.activity_modality
GENERATED ALWAYS AS (
  CASE provider_type::text
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
  END::fitness.activity_modality
) STORED;

ALTER TABLE fitness.activity
ADD CONSTRAINT activity_canonical_type_not_null_chk
CHECK (canonical_type IS NOT NULL) NOT VALID;

ALTER TABLE fitness.activity
VALIDATE CONSTRAINT activity_canonical_type_not_null_chk;

ALTER TABLE fitness.activity
ALTER COLUMN canonical_type SET NOT NULL;

ALTER TABLE fitness.activity
DROP CONSTRAINT activity_canonical_type_not_null_chk;

ALTER TABLE fitness.activity
ALTER COLUMN canonical_type DROP EXPRESSION,
ALTER COLUMN modality DROP EXPRESSION;

DROP TYPE fitness.activity_type;
-- Git merge conflicts here force developers to reconcile concurrent changes.

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
  ) AS dp ON TRUE
  WHERE
    a.provider_absent_at IS NULL
    AND a.deleted_at IS NULL
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
    a.provider_absent_at IS NOT NULL
    AND a.deleted_at IS NULL
    AND a.external_id IS NOT NULL
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
        AND sib.deleted_at IS NULL
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
          sib.provider_absent_at IS NULL AND sib.deleted_at IS NULL
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
      WHERE fg2.group_id = b.group_id AND r.name IS NOT NULL
      ORDER BY r.prio ASC LIMIT 1
    ) AS name,
    (
      SELECT r.notes FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.notes IS NOT NULL
      ORDER BY r.prio ASC LIMIT 1
    ) AS notes,
    (
      SELECT r.timezone FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id AND r.timezone IS NOT NULL
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
        AND r.external_id IS NOT NULL
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
