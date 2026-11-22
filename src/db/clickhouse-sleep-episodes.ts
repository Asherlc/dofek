import { standardViewHeader } from "./clickhouse-sql-helpers.ts";

export function buildSleepReadModelSql(): string {
  return `${standardViewHeader("analytics.v_sleep")}
${buildSleepSelectSql(false)}`;
}

/** Reuse the sleep priority and stage rules for a bounded, episode-level analysis. */
export function buildSleepEpisodeAnalysisSelectSql(preferDetectedOnset = false): string {
  return buildSleepSelectSql(true, preferDetectedOnset);
}

function buildSleepSelectSql(episodeAnalysis: boolean, preferDetectedOnset = false): string {
  const explicitMain = "('sleep', 'long_sleep', 'main')";
  const explicitNap = "('nap', 'late_nap', 'rest')";
  const materialized = episodeAnalysis ? "MATERIALIZED " : "";
  // The episode query groups a bounded user range without traversing each path in the overlap graph.
  return `WITH ${episodeAnalysis ? "" : "RECURSIVE"}
active_sleep AS ${materialized}(
  SELECT *
  FROM postgres_fitness.sleep_session FINAL
  WHERE _peerdb_is_deleted = 0
  ${
    episodeAnalysis
      ? `AND user_id = {userId:UUID}
    AND started_at < addDays(toDateTime({endDate:String}, 'UTC'), 2)
    AND coalesce(ended_at, started_at) >= subtractDays(toDateTime({startDate:String}, 'UTC'), 2)`
      : ""
  }
  ${
    preferDetectedOnset
      ? `AND formatDateTime(coalesce(ended_at, started_at), '%F', {analysisTimezone:String})
          BETWEEN {accessStartDate:String} AND {accessEndDate:String}`
      : ""
  }
),
active_provider_priority AS (
  SELECT *
  FROM postgres_fitness.provider_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
active_device_priority AS (
  SELECT *
  FROM postgres_fitness.device_priority FINAL
  WHERE _peerdb_is_deleted = 0
),
device_priority_match AS (
  SELECT sleep_id, sleep_priority, priority
  FROM (
    SELECT
      active_sleep.id AS sleep_id,
      active_device_priority.sleep_priority AS sleep_priority,
      active_device_priority.priority AS priority,
      row_number() OVER (
        PARTITION BY active_sleep.id
        ORDER BY length(active_device_priority.source_name_pattern) DESC
      ) AS row_number
    FROM active_sleep
    INNER JOIN active_device_priority
      ON active_device_priority.provider_id = active_sleep.provider_id
     AND active_sleep.source_name LIKE active_device_priority.source_name_pattern
  )
  WHERE row_number = 1
),
ranked AS ${materialized}(
  SELECT
    active_sleep.id AS id,
    active_sleep.provider_id AS provider_id,
    active_sleep.user_id AS user_id,
    active_sleep.started_at AS started_at,
    active_sleep.ended_at AS ended_at,
    active_sleep.duration_minutes AS duration_minutes,
    active_sleep.deep_minutes AS deep_minutes,
    active_sleep.rem_minutes AS rem_minutes,
    active_sleep.light_minutes AS light_minutes,
    active_sleep.awake_minutes AS awake_minutes,
    active_sleep.efficiency_pct AS efficiency_pct,
    active_sleep.staging_available AS staging_available,
    active_sleep.sleep_type AS sleep_type,
    active_sleep.source_name AS source_name,
    active_sleep.timezone AS timezone,
    active_sleep.start_utc_offset_minutes AS start_utc_offset_minutes,
    active_sleep.end_utc_offset_minutes AS end_utc_offset_minutes,
    active_sleep.local_time_source AS local_time_source,
    coalesce(device_priority_match.sleep_priority, active_provider_priority.sleep_priority, device_priority_match.priority, active_provider_priority.priority, 100) AS priority,
    ${
      episodeAnalysis
        ? `multiIf(
      active_sleep.is_nap OR active_sleep.sleep_type IN ${explicitNap}, 'nap',
      active_sleep.sleep_type IN ${explicitMain}, 'main',
      NULL
    ) AS stored_kind,`
        : ""
    }
    multiIf(
      ${episodeAnalysis ? "active_sleep.is_nap OR " : ""}active_sleep.sleep_type IN ${explicitNap}, true,
      active_sleep.sleep_type IN ${explicitMain}, false,
      active_sleep.sleep_type = 'not_main', coalesce(active_sleep.duration_minutes < 120, true),
      active_sleep.duration_minutes IS NOT NULL, active_sleep.duration_minutes < 120,
      false
    ) AS is_nap
  FROM active_sleep
  LEFT JOIN active_provider_priority
    ON active_provider_priority.provider_id = active_sleep.provider_id
  LEFT JOIN device_priority_match
    ON device_priority_match.sleep_id = active_sleep.id
),
pairs AS (
  SELECT
    left_sleep.id AS id1,
    right_sleep.id AS id2
  FROM ranked AS left_sleep
  INNER JOIN ranked AS right_sleep
    ON left_sleep.user_id = right_sleep.user_id
   AND toString(left_sleep.id) < toString(right_sleep.id)
   AND ((left_sleep.is_nap = right_sleep.is_nap AND dateDiff(
      'second',
      greatest(left_sleep.started_at, right_sleep.started_at),
      least(
        coalesce(left_sleep.ended_at, left_sleep.started_at + INTERVAL 8 HOUR),
        coalesce(right_sleep.ended_at, right_sleep.started_at + INTERVAL 8 HOUR)
      )
    ) / nullIf(dateDiff(
      'second',
      least(left_sleep.started_at, right_sleep.started_at),
      greatest(
        coalesce(left_sleep.ended_at, left_sleep.started_at + INTERVAL 8 HOUR),
        coalesce(right_sleep.ended_at, right_sleep.started_at + INTERVAL 8 HOUR)
      )
    ), 0) > 0.8)
    ${
      episodeAnalysis
        ? `OR (
      left_sleep.ended_at = right_sleep.ended_at
      AND left_sleep.ended_at > greatest(left_sleep.started_at, right_sleep.started_at)
      AND (
        left_sleep.provider_id != right_sleep.provider_id
        OR coalesce(left_sleep.source_name, '') != coalesce(right_sleep.source_name, '')
      )
      AND (
        isNull(left_sleep.stored_kind) OR isNull(right_sleep.stored_kind)
        OR left_sleep.stored_kind = right_sleep.stored_kind
      )
    )`
        : ""
    })
),
${
  episodeAnalysis
    ? `episode_groups AS (
  SELECT
    session_ids,
    arrayFold(
      (groups, pair) -> arrayMap(
        current_group -> if(
          current_group = greatest(groups[pair.1], groups[pair.2]),
          least(groups[pair.1], groups[pair.2]),
          current_group
        ),
        groups
      ),
      arrayMap(
        pair -> tuple(indexOf(session_ids, pair.1), indexOf(session_ids, pair.2)),
        overlapping_pairs
      ),
      session_ids
    ) AS group_ids
  FROM (SELECT groupArray(toString(id)) AS session_ids FROM ranked) AS sessions
  CROSS JOIN (
    SELECT groupArray(tuple(toString(id1), toString(id2))) AS overlapping_pairs FROM pairs
  ) AS edges
),
final_groups AS MATERIALIZED (
  SELECT toUUID(member.1) AS sleep_id, member.2 AS group_id
  FROM episode_groups
  ARRAY JOIN arrayZip(session_ids, group_ids) AS member
),`
    : `graph_edges AS (
  SELECT id1 AS from_id, id2 AS to_id
  FROM pairs
  UNION ALL
  SELECT id2 AS from_id, id1 AS to_id
  FROM pairs
),
connected_components AS (
  SELECT
    id AS sleep_id,
    id AS connected_sleep_id,
    [toString(id)] AS visited_sleep_ids
  FROM ranked
  UNION ALL
  SELECT
    connected_components.sleep_id AS sleep_id,
    graph_edges.to_id AS connected_sleep_id,
    arrayConcat(connected_components.visited_sleep_ids, [toString(graph_edges.to_id)]) AS visited_sleep_ids
  FROM connected_components
  INNER JOIN graph_edges
    ON graph_edges.from_id = connected_components.connected_sleep_id
  WHERE NOT has(connected_components.visited_sleep_ids, toString(graph_edges.to_id))
),
final_groups AS (
  SELECT sleep_id, min(toString(connected_sleep_id)) AS group_id
  FROM connected_components
  GROUP BY sleep_id
),
`
}
best AS (
  SELECT *
  FROM (
    SELECT
      final_groups.group_id AS group_id,
      ranked.id AS id,
      ranked.provider_id AS provider_id,
      ranked.user_id AS user_id,
      ranked.started_at AS started_at,
      ranked.ended_at AS ended_at,
      ranked.duration_minutes AS duration_minutes,
      ranked.deep_minutes AS deep_minutes,
      ranked.rem_minutes AS rem_minutes,
      ranked.light_minutes AS light_minutes,
      ranked.awake_minutes AS awake_minutes,
      ranked.efficiency_pct AS efficiency_pct,
      ranked.staging_available AS staging_available,
      ranked.sleep_type AS sleep_type,
      ranked.source_name AS source_name,
      ranked.timezone AS timezone,
      ranked.start_utc_offset_minutes AS start_utc_offset_minutes,
      ranked.end_utc_offset_minutes AS end_utc_offset_minutes,
      ranked.local_time_source AS local_time_source,
      ranked.priority AS priority,
      ranked.is_nap AS is_nap,
      row_number() OVER (
        PARTITION BY final_groups.group_id
        ORDER BY ${
          preferDetectedOnset
            ? "if(ranked.provider_id = 'polar' AND ranked.ended_at > ranked.started_at AND NOT ranked.is_nap, 0, 1), "
            : ""
        }ranked.priority ASC, toString(ranked.id) ASC
      ) AS row_number
    FROM final_groups
    INNER JOIN ranked
      ON ranked.id = final_groups.sleep_id
    ${
      episodeAnalysis
        ? "WHERE empty({providers:Array(String)}) OR has({providers:Array(String)}, ranked.provider_id)"
        : ""
    }
  )
  WHERE row_number = 1
)
SELECT
  best.id AS id,
  best.provider_id AS provider_id,
  best.user_id AS user_id,
  best.started_at AS started_at,
  best.ended_at AS ended_at,
  best.duration_minutes AS duration_minutes,
  if(best.staging_available, best.deep_minutes, NULL) AS deep_minutes,
  if(best.staging_available, best.rem_minutes, NULL) AS rem_minutes,
  if(best.staging_available, best.light_minutes, NULL) AS light_minutes,
  if(best.staging_available, best.awake_minutes, NULL) AS awake_minutes,
  best.staging_available AS staging_available,
  coalesce(
    best.efficiency_pct,
    multiIf(
      best.staging_available
        AND best.provider_id = 'apple_health'
        AND best.duration_minutes > 0,
      round((coalesce(best.deep_minutes, 0) + coalesce(best.rem_minutes, 0) + coalesce(best.light_minutes, 0)) / best.duration_minutes * 100, 1),
      best.staging_available
        AND best.provider_id IN ('eight-sleep', 'polar')
        AND best.duration_minutes > 0
        AND best.awake_minutes IS NOT NULL,
      round(best.duration_minutes / (best.duration_minutes + best.awake_minutes) * 100, 1),
      NULL
    )
  ) AS efficiency_pct,
  best.sleep_type AS sleep_type,
  ${
    episodeAnalysis
      ? `multiIf(
    countIf(ranked.stored_kind = 'main') > 0, false,
    countIf(ranked.stored_kind = 'nap') > 0, true,
    best.is_nap
  ) AS is_nap,
  countIf(isNotNull(ranked.stored_kind)) > 0 AS sleep_kind_recorded,
  arraySort(groupUniqArray(toString(ranked.id))) AS source_session_ids,`
      : "best.is_nap AS is_nap,"
  }
  best.source_name AS source_name,
  best.timezone AS timezone,
  best.start_utc_offset_minutes AS start_utc_offset_minutes,
  best.end_utc_offset_minutes AS end_utc_offset_minutes,
  best.local_time_source AS local_time_source,
  arraySort(groupUniqArray(ranked.provider_id)) AS source_providers
FROM best
INNER JOIN final_groups
  ON final_groups.group_id = best.group_id
INNER JOIN ranked
  ON ranked.id = final_groups.sleep_id
GROUP BY
  best.id,
  best.provider_id,
  best.user_id,
  best.started_at,
  best.ended_at,
  best.duration_minutes,
  best.deep_minutes,
  best.rem_minutes,
  best.light_minutes,
  best.awake_minutes,
  best.staging_available,
  best.efficiency_pct,
  best.sleep_type,
  best.is_nap,
  best.source_name,
  best.timezone,
  best.start_utc_offset_minutes,
  best.end_utc_offset_minutes,
  best.local_time_source`;
}
