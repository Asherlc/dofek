import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../clickhouse.ts";
import { createMigration } from "./0076_activity_sensor_provenance.ts";

const columnSchema = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
  }),
);

describe("0076_activity_sensor_provenance", () => {
  const database = `activity_sensor_provenance_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("adds provenance columns idempotently to existing analytics tables", async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.sensor_scalar_sample (
        id UUID,
        provider_id String,
        device_id Nullable(String)
      ) ENGINE = MergeTree ORDER BY id`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_sensor (
        provider_id Nullable(String)
      ) ENGINE = MergeTree ORDER BY tuple()`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_sensor_sample (
        scalar Nullable(Float32)
      ) ENGINE = MergeTree ORDER BY tuple()`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_sample (
        source_metric_stream_id UUID
      ) ENGINE = MergeTree ORDER BY tuple()`,
    });

    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of createMigration().statements) {
        await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
      }
    }

    const result = await client.query({
      query: `SELECT name, type
        FROM system.columns
        WHERE database = {database:String}
          AND table IN (
            'sensor_scalar_sample',
            'deduped_sensor',
            'activity_sensor_sample',
            'activity_location_sample'
          )
          AND name IN (
            'member_activity_id',
            'provider_id',
            'source_external_id',
            'source_type',
            'source_metric_stream_id',
            'measurement_kind'
          )
        ORDER BY table, position`,
      query_params: { database },
      format: "JSONEachRow",
    });
    const columns = columnSchema.parse(await result.json());

    expect(columns.filter(({ name }) => name === "measurement_kind")).toEqual([
      { name: "measurement_kind", type: "LowCardinality(String)" },
      { name: "measurement_kind", type: "LowCardinality(String)" },
      { name: "measurement_kind", type: "LowCardinality(String)" },
      { name: "measurement_kind", type: "LowCardinality(String)" },
    ]);
    expect(columns.filter(({ name }) => name === "member_activity_id")).toEqual([
      { name: "member_activity_id", type: "Nullable(UUID)" },
      { name: "member_activity_id", type: "Nullable(UUID)" },
      { name: "member_activity_id", type: "Nullable(UUID)" },
      { name: "member_activity_id", type: "Nullable(UUID)" },
    ]);
    expect(columns.filter(({ name }) => name === "source_external_id")).toHaveLength(4);
    expect(columns.filter(({ name }) => name === "source_type")).toHaveLength(4);
    expect(columns.filter(({ name }) => name === "source_metric_stream_id")).toHaveLength(2);
  });
});
