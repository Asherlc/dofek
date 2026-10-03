import type { ClickHouseClient } from "../../../../src/db/clickhouse.ts";
import type { MetricStreamClickHouseReader } from "./heart-rate-repository.ts";

export interface HeartRateFixtureRow {
  id: string;
  user_id: string;
  activity_id?: string | null;
  provider_id: string;
  recorded_at: string;
  scalar: number | null;
  channel?: string;
  version?: number;
  ingested_at?: string;
  is_deleted?: 0 | 1;
}

export async function insertHeartRateFixtureRows(
  client: ClickHouseClient,
  table: string,
  rows: HeartRateFixtureRow[],
): Promise<void> {
  if (!client.insert) throw new Error("Heart-rate fixtures require an insert-capable client");
  await client.insert({
    table,
    format: "JSONEachRow",
    values: rows.map((row) => ({
      channel: "heart_rate",
      version: 1,
      ingested_at: "2026-04-12 00:00:00.000",
      is_deleted: 0,
      ...row,
    })),
  });
}

export function heartRateFixtureReader(
  client: ClickHouseClient,
  table: string,
  observe?: (query: string, params: Record<string, unknown> | undefined) => void,
): MetricStreamClickHouseReader {
  return {
    async query(schema, query, params) {
      const fixtureQuery = query.replaceAll("ingest.metric_stream", table);
      observe?.(fixtureQuery, params);
      const result = await client.query({
        query: fixtureQuery,
        query_params: params,
        format: "JSONEachRow",
      });
      return (await result.json()).map((row) => schema.parse(row));
    },
  };
}

// The unchanged reader's FINAL query is the bounded access path's parity baseline.
export const legacyDailyHeartRateQuery = `WITH minute_samples AS (
  SELECT provider_id, toStartOfMinute(toDateTime(recorded_at)) AS minute_bucket,
    toInt32(round(avg(scalar))) AS heart_rate
  FROM ingest.metric_stream FINAL
  WHERE user_id = {userId:UUID} AND channel = 'heart_rate'
    AND is_deleted = 0 AND scalar > 0
    AND recorded_at >= toDateTime({date:Date}, {timezone:String})
    AND recorded_at < toDateTime({date:Date}, {timezone:String}) + INTERVAL 1 DAY
  GROUP BY provider_id, minute_bucket
)
SELECT provider_id,
  formatDateTime(minute_bucket, '%Y-%m-%dT%H:%i:%S.000Z') AS recorded_at,
  heart_rate,
  count() OVER (PARTITION BY provider_id) AS sample_count,
  min(heart_rate) OVER (PARTITION BY provider_id) AS min_heart_rate,
  toInt32(round(avg(heart_rate) OVER (PARTITION BY provider_id))) AS avg_heart_rate,
  max(heart_rate) OVER (PARTITION BY provider_id) AS max_heart_rate
FROM minute_samples ORDER BY provider_id, minute_bucket`;
