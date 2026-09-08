import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const statements = [
  `ALTER TABLE analytics.sensor_scalar_sample
    ADD COLUMN IF NOT EXISTS member_activity_id Nullable(UUID) AFTER id,
    ADD COLUMN IF NOT EXISTS source_external_id Nullable(String) AFTER provider_id,
    ADD COLUMN IF NOT EXISTS source_type Nullable(String) AFTER device_id,
    ADD COLUMN IF NOT EXISTS measurement_kind LowCardinality(String) DEFAULT 'unknown' AFTER source_type`,
  `ALTER TABLE analytics.deduped_sensor
    ADD COLUMN IF NOT EXISTS member_activity_id Nullable(UUID) AFTER provider_id,
    ADD COLUMN IF NOT EXISTS device_id Nullable(String) AFTER member_activity_id,
    ADD COLUMN IF NOT EXISTS source_external_id Nullable(String) AFTER device_id,
    ADD COLUMN IF NOT EXISTS source_type Nullable(String) AFTER source_external_id,
    ADD COLUMN IF NOT EXISTS measurement_kind LowCardinality(String) DEFAULT 'unknown' AFTER source_type`,
  `ALTER TABLE analytics.activity_sensor_sample
    ADD COLUMN IF NOT EXISTS provider_id Nullable(String) AFTER scalar,
    ADD COLUMN IF NOT EXISTS member_activity_id Nullable(UUID) AFTER provider_id,
    ADD COLUMN IF NOT EXISTS device_id Nullable(String) AFTER member_activity_id,
    ADD COLUMN IF NOT EXISTS source_external_id Nullable(String) AFTER device_id,
    ADD COLUMN IF NOT EXISTS source_type Nullable(String) AFTER source_external_id,
    ADD COLUMN IF NOT EXISTS source_metric_stream_id Nullable(UUID) AFTER source_type,
    ADD COLUMN IF NOT EXISTS measurement_kind LowCardinality(String) DEFAULT 'unknown' AFTER source_metric_stream_id`,
  `ALTER TABLE analytics.activity_location_sample
    ADD COLUMN IF NOT EXISTS member_activity_id Nullable(UUID) AFTER source_metric_stream_id,
    ADD COLUMN IF NOT EXISTS provider_id Nullable(String) AFTER member_activity_id,
    ADD COLUMN IF NOT EXISTS source_external_id Nullable(String) AFTER provider_id,
    ADD COLUMN IF NOT EXISTS device_id Nullable(String) AFTER source_external_id,
    ADD COLUMN IF NOT EXISTS source_type Nullable(String) AFTER device_id,
    ADD COLUMN IF NOT EXISTS measurement_kind LowCardinality(String) DEFAULT 'unknown' AFTER source_type`,
];

const tableNames = [
  "sensor_scalar_sample",
  "deduped_sensor",
  "activity_sensor_sample",
  "activity_location_sample",
] as const;

async function tableExists(client: ClickHouseCommandClient, tableName: string): Promise<boolean> {
  if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
  const result = await client.query<{ count: number | string }>({
    query:
      "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
    query_params: { name: tableName },
    format: "JSONEachRow",
  });
  const [row] = z
    .tuple([
      z.object({
        count: z.union([
          z.number().int().nonnegative(),
          z.string().regex(/^\d+$/).transform(Number),
        ]),
      }),
    ])
    .parse(await result.json(), { error: () => "Expected one ClickHouse table count row" });
  return row.count > 0;
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0076_activity_sensor_provenance",
    statements,
    run: async (client) => {
      for (const [index, tableName] of tableNames.entries()) {
        if (await tableExists(client, tableName)) {
          const statement = statements[index];
          if (!statement) throw new Error(`Missing migration statement for ${tableName}`);
          await runClickHouseMigrationStatement(client, statement);
        }
      }
    },
  };
}
