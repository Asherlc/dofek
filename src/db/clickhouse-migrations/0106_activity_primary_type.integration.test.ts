import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0106_activity_primary_type.ts";

describe("activity primary type schema migration", () => {
  const database = `activity_primary_type_${randomBytes(6).toString("hex")}`;
  const client = createClient({ url: process.env.CLICKHOUSE_URL });
  const activityId = "00000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
  });

  beforeEach(async () => {
    await client.command({ query: `DROP TABLE IF EXISTS ${database}.deduped_activities SYNC` });
    await client.command({ query: `DROP TABLE IF EXISTS ${database}.cycling_activity SYNC` });
    await createLegacyTable("deduped_activities");
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  async function createLegacyTable(table: string): Promise<void> {
    await client.command({
      query: `CREATE TABLE ${database}.${table} (
        activity_id UUID, refreshed_at DateTime64(9,'UTC')
      ) ENGINE = MergeTree ORDER BY activity_id`,
    });
    await client.command({
      query: `INSERT INTO ${database}.${table} VALUES ('${activityId}',now64(9,'UTC'))`,
    });
  }

  async function applySchemaSteps(): Promise<void> {
    const mappedClient: ClickHouseCommandClient = {
      command: async (options) => {
        // The model suite covers serving views; execute this migration's schema steps here.
        if (options.query.startsWith("ALTER TABLE")) {
          await client.command({ query: options.query.replaceAll("analytics.", `${database}.`) });
        }
      },
      query: async <TRow extends object>(options: {
        query: string;
        format: "JSONEachRow";
        query_params?: Record<string, unknown>;
      }) => {
        const result = await client.query({
          ...options,
          query_params: { ...options.query_params, database },
        });
        return { json: () => result.json<TRow>() };
      },
    };
    const migration = createMigration();
    if (!migration.run) throw new Error("Expected schema-aware primary type migration");
    await migration.run(mappedClient, "postgres://test");
  }

  async function readPrimaryTypes(table: string): Promise<Array<{ primary_canonical_type: null }>> {
    const result = await client.query({
      query: `SELECT primary_canonical_type FROM ${database}.${table}`,
      format: "JSONEachRow",
    });
    return z.array(z.object({ primary_canonical_type: z.null() })).parse(await result.json());
  }

  it("adds the required identity column before the first dbt cycling build", async () => {
    await applySchemaSteps();
    await applySchemaSteps();

    expect(await readPrimaryTypes("deduped_activities")).toEqual([
      { primary_canonical_type: null },
    ]);
  });

  it("adds nullable primary types to existing identity and cycling rows idempotently", async () => {
    await createLegacyTable("cycling_activity");
    await applySchemaSteps();
    await applySchemaSteps();

    for (const table of ["deduped_activities", "cycling_activity"]) {
      expect(await readPrimaryTypes(table)).toEqual([{ primary_canonical_type: null }]);
    }
  });

  it("fails when the required deduped activity table is missing", async () => {
    await client.command({ query: `DROP TABLE ${database}.deduped_activities SYNC` });

    await expect(applySchemaSteps()).rejects.toThrow("deduped_activities");
  });
});
