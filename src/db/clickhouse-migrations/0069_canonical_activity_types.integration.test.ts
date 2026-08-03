import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  type ClickHouseCommandClient,
  createClickHouseClientFromEnv,
} from "../clickhouse.ts";
import { createMigration } from "./0069_canonical_activity_types.ts";

const activityRowsSchema = z.array(
  z.object({
    canonical_type: z.string(),
    provider_type: z.string().nullable(),
    modality: z.string().nullable(),
  }),
);

describe("0069_canonical_activity_types migration", () => {
  const database = `canonical_activity_types_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity (
        id UUID,
        activity_type String,
        _peerdb_is_deleted UInt8 DEFAULT 0
      )
      ENGINE = MergeTree
      ORDER BY id`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_summary_rows (
        activity_id UUID,
        activity_type String
      )
      ENGINE = MergeTree
      ORDER BY activity_id`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity VALUES
        (generateUUIDv4(), 'road_cycling', 0),
        (generateUUIDv4(), 'rock_climbing', 0),
        (generateUUIDv4(), '', 1)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows VALUES
        (generateUUIDv4(), 'road_cycling')`,
    });

    const isolatedClient: ClickHouseCommandClient = {
      command: (options) =>
        client.command({
          ...options,
          query: options.query
            .replaceAll("postgres_fitness.activity", `${database}.activity`)
            .replaceAll("analytics.activity_summary_rows", `${database}.activity_summary_rows`),
        }),
      query: (options) =>
        client.query({
          ...options,
          query_params: {
            ...options.query_params,
            database:
              options.query_params?.database === "postgres_fitness" ||
              options.query_params?.database === "analytics"
                ? database
                : options.query_params?.database,
          },
        }),
    };

    await createMigration().run?.(isolatedClient, "");
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` });
  });

  it("preserves the exact old type while canonicalizing type and modality", async () => {
    const result = await client.query({
      query: `SELECT canonical_type, provider_type, modality
        FROM ${database}.activity
        WHERE _peerdb_is_deleted = 0
        ORDER BY provider_type`,
      format: "JSONEachRow",
    });

    expect(activityRowsSchema.parse(await result.json())).toEqual([
      {
        canonical_type: "cycling",
        provider_type: "road_cycling",
        modality: "road",
      },
      {
        canonical_type: "climbing",
        provider_type: "rock_climbing",
        modality: null,
      },
    ]);
  });

  it("renames and canonicalizes serving-table activity types", async () => {
    const result = await client.query({
      query: `SELECT canonical_type, provider_type, modality
        FROM ${database}.activity_summary_rows`,
      format: "JSONEachRow",
    });

    expect(activityRowsSchema.parse(await result.json())).toEqual([
      {
        canonical_type: "cycling",
        provider_type: null,
        modality: null,
      },
    ]);
  });
});
