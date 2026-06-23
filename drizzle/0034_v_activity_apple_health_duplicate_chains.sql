-- Ignore superseded Apple Health duplicate tombstones when deciding group visibility.

CREATE OR REPLACE VIEW fitness.v_activity AS
WITH RECURSIVE ranked AS (
  SELECT
    a.*,
    COALESCE(dp.priority, pp.priority, 100) AS prio
  FROM fitness.activity AS a
  LEFT JOIN fitness.provider_priority AS pp ON a.provider_id = pp.provider_id
  LEFT JOIN LATERAL (
    SELECT dp2.priority
    FROM fitness.device_priority AS dp2
    WHERE
      dp2.provider_id = a.provider_id
      AND a.source_name LIKE dp2.source_name_pattern
    ORDER BY LENGTH(dp2.source_name_pattern) DESC
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
    a.external_id,
    a.started_at,
    a.ended_at,
    a.provider_absent_at
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
    t.external_id,
    t.started_at,
    t.ended_at,
    t.provider_absent_at
  FROM tombstoned AS t
  WHERE t.provider_id <> 'apple_health'
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.provider_id,
    t.external_id,
    t.started_at,
    t.ended_at,
    t.provider_absent_at
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
        AND COALESCE(
          NULLIF(TRIM(sib.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || sib.started_at::text || ':' || COALESCE(sib.ended_at::text, '') || ':'
          || COALESCE(
            NULLIF(TRIM(sib.raw ->> 'sourceName'), ''),
            NULLIF(TRIM(sib.source_name), ''),
            ''
          )
        ) = COALESCE(
          NULLIF(TRIM(a.raw -> 'metadata' ->> 'HKMetadataKeySyncIdentifier'), ''),
          'time:' || a.started_at::text || ':' || COALESCE(a.ended_at::text, '') || ':'
          || COALESCE(
            NULLIF(TRIM(a.raw ->> 'sourceName'), ''),
            NULLIF(TRIM(a.source_name), ''),
            ''
          )
        )
        AND (
          sib.provider_absent_at IS null AND sib.deleted_at IS null
          OR COALESCE(
            CASE
              WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
            END,
            0
          ) > COALESCE(
            CASE
              WHEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                THEN (a.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
            END,
            0
          )
          OR (
            COALESCE(
              CASE
                WHEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion') ~ '^[0-9]+$'
                  THEN (sib.raw -> 'metadata' ->> 'HKMetadataKeySyncVersion')::bigint
              END,
              0
            ) = COALESCE(
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
    r.started_at,
    COALESCE(r.ended_at, r.started_at + interval '1 hour') AS ended_at
  FROM ranked AS r
  UNION ALL
  SELECT
    t.id,
    t.user_id,
    t.started_at,
    COALESCE(t.ended_at, t.started_at + interval '1 hour') AS ended_at
  FROM tombstoned AS t
),

pairs AS (
  SELECT
    c1.id AS id1,
    c2.id AS id2
  FROM clusterable AS c1
  INNER JOIN clusterable AS c2
    ON
      c1.user_id = c2.user_id
      AND c1.id < c2.id
      AND EXTRACT(EPOCH FROM (
        LEAST(c1.ended_at, c2.ended_at) - GREATEST(c1.started_at, c2.started_at)
      )) / NULLIF(EXTRACT(EPOCH FROM (
        GREATEST(c1.ended_at, c2.ended_at) - LEAST(c1.started_at, c2.started_at)
      )), 0) > 0.8
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
    MIN(group_id) AS group_id
  FROM clusters
  GROUP BY activity_id
),

best_per_group AS (
  SELECT DISTINCT ON (fg.group_id)
    fg.group_id,
    r.id AS canonical_id,
    r.provider_id,
    r.user_id,
    r.activity_type,
    r.started_at,
    r.ended_at,
    r.source_name,
    r.prio
  FROM final_groups AS fg
  INNER JOIN ranked AS r ON fg.activity_id = r.id
  ORDER BY fg.group_id ASC, r.prio ASC, r.id ASC
),

absent_source_links AS (
  SELECT
    fg.group_id,
    JSONB_AGG(
      JSONB_BUILD_OBJECT(
        'providerId', t.provider_id,
        'externalId', t.external_id,
        'memberActivityId', t.id,
        'providerAbsentAt', t.provider_absent_at
      )
      ORDER BY t.provider_id
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
    b.activity_type,
    b.started_at,
    b.ended_at,
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
      SELECT JSONB_OBJECT_AGG(sub.raw_key, sub.raw_value)
      FROM (
        SELECT
          raw_entry.raw_key,
          raw_entry.raw_value,
          ROW_NUMBER() OVER (PARTITION BY raw_entry.raw_key ORDER BY r.prio ASC) AS raw_rank
        FROM final_groups AS fg2
        INNER JOIN ranked AS r ON fg2.activity_id = r.id
        CROSS JOIN LATERAL JSONB_EACH(COALESCE(r.raw, '{}'::jsonb)) AS raw_entry (raw_key, raw_value)
        WHERE fg2.group_id = b.group_id
      ) AS sub
      WHERE sub.raw_rank = 1
    ) AS raw,
    (
      SELECT ARRAY_AGG(DISTINCT r.provider_id ORDER BY r.provider_id)
      FROM final_groups AS fg2 INNER JOIN ranked AS r ON fg2.activity_id = r.id
      WHERE fg2.group_id = b.group_id
    ) AS source_providers,
    (
      SELECT
        JSONB_AGG(
          JSONB_BUILD_OBJECT('providerId', r.provider_id, 'externalId', r.external_id)
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
  LEFT JOIN absent_source_links ON b.group_id = absent_source_links.group_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM tombstoned_groups AS tg
    WHERE tg.group_id = b.group_id
  )
)

SELECT
  m.canonical_id AS id,
  m.provider_id,
  m.user_id,
  m.canonical_id AS primary_activity_id,
  m.activity_type,
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
