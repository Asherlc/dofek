import type { ClickHouseCommandClient } from "../clickhouse.ts";
import {
  buildIngestMetricStreamCreateTableSql,
  INGEST_DATABASE,
  LEGACY_METRIC_STREAM_TABLE,
  METRIC_STREAM_TABLE,
} from "../../metric-stream/clickhouse-table.ts";
import type { ClickHouseMigration } from "./types.ts";

async function legacyMetricStreamTableExists(client: ClickHouseCommandClient): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query({
    query: `SELECT count() AS count
      FROM system.tables
      WHERE database = 'postgres_fitness'
        AND name = 'metric_stream'`,
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ count: string }>;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function copyLegacyMetricStreamToIngest(client: ClickHouseCommandClient): Promise<void> {
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE}
      SELECT
        id,
        activity_id,
        user_id,
        recorded_at,
        channel,
        provider_id,
        external_id,
        device_id,
        source_type,
        scalar,
        vector,
        point,
        metadata,
        _peerdb_synced_at AS ingested_at,
        _peerdb_is_deleted AS is_deleted,
        _peerdb_version AS version
      FROM ${LEGACY_METRIC_STREAM_TABLE}`,
  });
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0034_move_metric_stream_to_ingest",
    statements: [`CREATE DATABASE IF NOT EXISTS ${INGEST_DATABASE}`, buildIngestMetricStreamCreateTableSql()],
    run: async (client) => {
      if (!(await legacyMetricStreamTableExists(client))) {
        return;
      }

      await copyLegacyMetricStreamToIngest(client);
      await client.command({ query: `DROP TABLE IF EXISTS ${LEGACY_METRIC_STREAM_TABLE}` });
    },
  };
}
