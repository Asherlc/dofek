import { z } from "zod";
import { METRIC_STREAM_TABLE } from "../metric-stream/clickhouse-table.ts";
import type { ClickHouseClient } from "./clickhouse.ts";
import { bodyMeasurementChannelListSql } from "./clickhouse-read-models.ts";

export interface BodyMeasurementSampleBackfillRange {
  start: Date;
  end: Date;
}

const missingCountRowsSchema = z.array(
  z.object({ missing_count: z.coerce.number().int().nonnegative() }),
);

const backfillCommandResultSchema = z.object({
  summary: z.object({ written_rows: z.coerce.number().int().nonnegative() }),
});

function clickHouseDateTimeParameter(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function backfillQueryParams(range: BodyMeasurementSampleBackfillRange): Record<string, string> {
  return {
    start: clickHouseDateTimeParameter(range.start),
    end: clickHouseDateTimeParameter(range.end),
  };
}

function missingBodyMeasurementSampleRowsSql(): string {
  return `FROM ${METRIC_STREAM_TABLE} AS metric_stream FINAL
LEFT ANTI JOIN analytics.body_measurement_sample AS existing_sample FINAL
  ON existing_sample.id = metric_stream.id
 AND existing_sample._peerdb_version >= metric_stream.version
 AND existing_sample.recorded_at >= {start:DateTime64(6)}
 AND existing_sample.recorded_at < {end:DateTime64(6)}
WHERE metric_stream.channel IN (${bodyMeasurementChannelListSql()})
  AND metric_stream.recorded_at >= {start:DateTime64(6)}
  AND metric_stream.recorded_at < {end:DateTime64(6)}`;
}

export async function countMissingBodyMeasurementSamples(
  client: ClickHouseClient,
  range: BodyMeasurementSampleBackfillRange,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS missing_count
${missingBodyMeasurementSampleRowsSql()}`,
    format: "JSONEachRow",
    query_params: backfillQueryParams(range),
  });
  const rows = missingCountRowsSchema.parse(await result.json());
  return rows[0]?.missing_count ?? 0;
}

export async function backfillMissingBodyMeasurementSamples(
  client: ClickHouseClient,
  range: BodyMeasurementSampleBackfillRange,
): Promise<number> {
  const result = await client.command({
    query: `INSERT INTO analytics.body_measurement_sample (
  id,
  provider_id,
  user_id,
  recorded_at,
  channel,
  external_id,
  device_id,
  source_type,
  scalar,
  _peerdb_synced_at,
  _peerdb_is_deleted,
  _peerdb_version
)
SELECT
  metric_stream.id,
  metric_stream.provider_id,
  metric_stream.user_id,
  metric_stream.recorded_at,
  metric_stream.channel,
  metric_stream.external_id,
  metric_stream.device_id,
  metric_stream.source_type,
  metric_stream.scalar,
  metric_stream.ingested_at,
  metric_stream.is_deleted,
  metric_stream.version
${missingBodyMeasurementSampleRowsSql()}`,
    query_params: backfillQueryParams(range),
    clickhouse_settings: { wait_end_of_query: 1 },
  });
  return backfillCommandResultSchema.parse(result).summary.written_rows;
}
