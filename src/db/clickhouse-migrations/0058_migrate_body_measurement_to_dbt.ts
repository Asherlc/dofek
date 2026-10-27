import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const createTableSql = `CREATE TABLE IF NOT EXISTS analytics.body_measurement (
  id UUID,
  provider_id String,
  user_id UUID,
  external_id String,
  recorded_at DateTime64(6, 'UTC'),
  created_at DateTime64(9, 'UTC'),
  weight_kg Nullable(Float32),
  body_fat_pct Nullable(Float32),
  muscle_mass_kg Nullable(Float32),
  bone_mass_kg Nullable(Float32),
  water_pct Nullable(Float32),
  bmi Nullable(Float32),
  height_cm Nullable(Float32),
  waist_circumference_cm Nullable(Float32),
  systolic_bp Nullable(Float32),
  diastolic_bp Nullable(Float32),
  heart_pulse Nullable(Float32),
  temperature_c Nullable(Float32),
  source_name Nullable(String),
  source_providers Array(String),
  source_refreshed_at DateTime64(9, 'UTC'),
  is_deleted UInt8,
  refresh_version UInt64,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, id)`;

const bootstrapTableSql = `INSERT INTO analytics.body_measurement (
  id,
  provider_id,
  user_id,
  external_id,
  recorded_at,
  created_at,
  weight_kg,
  body_fat_pct,
  muscle_mass_kg,
  bone_mass_kg,
  water_pct,
  bmi,
  height_cm,
  waist_circumference_cm,
  systolic_bp,
  diastolic_bp,
  heart_pulse,
  temperature_c,
  source_name,
  source_providers,
  source_refreshed_at,
  is_deleted,
  refresh_version,
  refreshed_at
)
SELECT
  id,
  provider_id,
  user_id,
  external_id,
  recorded_at,
  created_at,
  weight_kg,
  body_fat_pct,
  muscle_mass_kg,
  bone_mass_kg,
  water_pct,
  bmi,
  height_cm,
  waist_circumference_cm,
  systolic_bp,
  diastolic_bp,
  heart_pulse,
  temperature_c,
  source_name,
  source_providers,
  created_at AS source_refreshed_at,
  toUInt8(0) AS is_deleted,
  toUInt64(toUnixTimestamp64Nano(created_at)) AS refresh_version,
  created_at AS refreshed_at
FROM analytics.v_body_measurement`;

const createServingViewSql = `CREATE VIEW IF NOT EXISTS analytics.v_body_measurement AS
SELECT
  id,
  provider_id,
  user_id,
  external_id,
  recorded_at,
  created_at,
  weight_kg,
  body_fat_pct,
  muscle_mass_kg,
  bone_mass_kg,
  water_pct,
  bmi,
  height_cm,
  waist_circumference_cm,
  systolic_bp,
  diastolic_bp,
  heart_pulse,
  temperature_c,
  source_name,
  source_providers
FROM analytics.body_measurement FINAL
WHERE is_deleted = 0`;

const statements = [
  createTableSql,
  bootstrapTableSql,
  "DROP VIEW IF EXISTS analytics.v_body_measurement",
  "DROP TABLE IF EXISTS analytics.v_body_measurement",
  createServingViewSql,
];

async function objectExists(
  client: ClickHouseCommandClient,
  database: string,
  name: string,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query({
    query: `SELECT count() AS count
FROM system.tables
WHERE database = {database:String}
  AND name = {name:String}`,
    query_params: { database, name },
    format: "JSONEachRow",
  });
  const rows = z.tuple([z.object({ count: z.coerce.number().int() })]).parse(await result.json());
  return rows[0].count > 0;
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0058_migrate_body_measurement_to_dbt",
    statements,
    run: async (client) => {
      await runClickHouseMigrationStatement(client, createTableSql);
      if (await objectExists(client, "analytics", "v_body_measurement")) {
        await runClickHouseMigrationStatement(client, bootstrapTableSql);
      }
      await runClickHouseMigrationStatement(
        client,
        "DROP VIEW IF EXISTS analytics.v_body_measurement",
      );
      await runClickHouseMigrationStatement(
        client,
        "DROP TABLE IF EXISTS analytics.v_body_measurement",
      );
      await runClickHouseMigrationStatement(client, createServingViewSql);
    },
  };
}
