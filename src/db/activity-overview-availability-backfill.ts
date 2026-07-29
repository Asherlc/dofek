import { z } from "zod";
import type { ClickHouseClient } from "./clickhouse.ts";

export interface ActivityOverviewAvailabilityBackfillOptions {
  start: Date;
  end: Date;
  execute: boolean;
}

export interface ActivityOverviewAvailabilityBackfillResult {
  distanceRows: number;
  elevationRows: number;
}

const countRowsSchema = z.array(
  z.object({ candidate_count: z.coerce.number().int().nonnegative() }),
);

function queryParams(options: ActivityOverviewAvailabilityBackfillOptions): Record<string, string> {
  return {
    start: options.start.toISOString(),
    end: options.end.toISOString(),
  };
}

function boundedActivitySql(): string {
  return `SELECT
  activity_id,
  user_id
FROM analytics.deduped_activities FINAL
WHERE is_deleted = 0
  AND started_at >= parseDateTime64BestEffort({start:String}, 6, 'UTC')
  AND started_at < parseDateTime64BestEffort({end:String}, 6, 'UTC')`;
}

function distanceCandidateRowsSql(): string {
  return `WITH
bounded_activity AS (
  ${boundedActivitySql()}
),
candidate_summary AS (
  SELECT summary.*
  FROM analytics.activity_location_summary_rows AS summary FINAL
  INNER JOIN bounded_activity
    ON bounded_activity.activity_id = summary.activity_id
   AND bounded_activity.user_id = summary.user_id
  WHERE summary.is_deleted = 0
    AND summary.total_distance = 0
),
valid_sample_counts AS (
  SELECT
    sample.activity_id,
    sample.user_id,
    count() AS valid_sample_count
  FROM analytics.activity_location_sample AS sample FINAL
  WHERE sample.is_deleted = 0
    AND sample.lat IS NOT NULL
    AND sample.lng IS NOT NULL
    AND (sample.user_id, sample.activity_id) IN (
      SELECT user_id, activity_id
      FROM candidate_summary
    )
  GROUP BY sample.activity_id, sample.user_id
)
SELECT candidate_summary.*
FROM candidate_summary
LEFT JOIN valid_sample_counts
  ON valid_sample_counts.activity_id = candidate_summary.activity_id
 AND valid_sample_counts.user_id = candidate_summary.user_id
WHERE coalesce(valid_sample_counts.valid_sample_count, 0) < 2`;
}

function elevationCandidateRowsSql(): string {
  return `WITH
bounded_activity AS (
  ${boundedActivitySql()}
),
candidate_summary AS (
  SELECT summary.*
  FROM analytics.activity_sensor_summary_rows AS summary FINAL
  INNER JOIN bounded_activity
    ON bounded_activity.activity_id = summary.activity_id
   AND bounded_activity.user_id = summary.user_id
  WHERE summary.is_deleted = 0
    AND summary.elevation_gain_m = 0
),
valid_sample_counts AS (
  SELECT
    sample.activity_id,
    sample.user_id,
    count() AS valid_sample_count
  FROM analytics.activity_sensor_sample AS sample FINAL
  WHERE sample.is_deleted = 0
    AND sample.channel = 'altitude'
    AND sample.scalar IS NOT NULL
    AND (sample.user_id, sample.activity_id) IN (
      SELECT user_id, activity_id
      FROM candidate_summary
    )
  GROUP BY sample.activity_id, sample.user_id
)
SELECT candidate_summary.*
FROM candidate_summary
LEFT JOIN valid_sample_counts
  ON valid_sample_counts.activity_id = candidate_summary.activity_id
 AND valid_sample_counts.user_id = candidate_summary.user_id
WHERE coalesce(valid_sample_counts.valid_sample_count, 0) < 2`;
}

async function countCandidates(
  client: ClickHouseClient,
  candidateRowsSql: string,
  options: ActivityOverviewAvailabilityBackfillOptions,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS candidate_count
FROM (
  ${candidateRowsSql}
)`,
    format: "JSONEachRow",
    query_params: queryParams(options),
  });
  const rows = countRowsSchema.parse(await result.json());
  return rows[0]?.candidate_count ?? 0;
}

async function writeDistanceCandidates(
  client: ClickHouseClient,
  options: ActivityOverviewAvailabilityBackfillOptions,
): Promise<void> {
  await client.command({
    query: `INSERT INTO analytics.activity_location_summary_rows
SELECT candidate.* REPLACE(
  CAST(NULL, 'Nullable(Float64)') AS total_distance,
  greatest(
    candidate.refresh_version + 1,
    toUInt64(toUnixTimestamp64Nano(now64(9, 'UTC')))
  ) AS refresh_version,
  now64(9, 'UTC') AS refreshed_at
)
FROM (
  ${distanceCandidateRowsSql()}
) AS candidate`,
    query_params: queryParams(options),
    clickhouse_settings: { wait_end_of_query: 1 },
  });
}

async function writeElevationCandidates(
  client: ClickHouseClient,
  options: ActivityOverviewAvailabilityBackfillOptions,
): Promise<void> {
  await client.command({
    query: `INSERT INTO analytics.activity_sensor_summary_rows
SELECT candidate.* REPLACE(
  CAST(NULL, 'Nullable(Float64)') AS elevation_gain_m,
  greatest(
    candidate.refresh_version + 1,
    toUInt64(toUnixTimestamp64Nano(now64(9, 'UTC')))
  ) AS refresh_version,
  now64(9, 'UTC') AS refreshed_at
)
FROM (
  ${elevationCandidateRowsSql()}
) AS candidate`,
    query_params: queryParams(options),
    clickhouse_settings: { wait_end_of_query: 1 },
  });
}

export async function backfillActivityOverviewAvailability(
  client: ClickHouseClient,
  options: ActivityOverviewAvailabilityBackfillOptions,
): Promise<ActivityOverviewAvailabilityBackfillResult> {
  const distanceRows = await countCandidates(client, distanceCandidateRowsSql(), options);
  const elevationRows = await countCandidates(client, elevationCandidateRowsSql(), options);

  if (options.execute) {
    if (distanceRows > 0) {
      await writeDistanceCandidates(client, options);
    }
    if (elevationRows > 0) {
      await writeElevationCandidates(client, options);
    }
  }

  return { distanceRows, elevationRows };
}
