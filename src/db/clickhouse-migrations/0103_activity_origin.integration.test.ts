import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0103_activity_origin.ts";

describe("populated activity origin migration", () => {
  const client = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    request_timeout: 2000,
  });
  const database = `origin_migration_${randomUUID().replaceAll("-", "")}`;
  const memberId = "00000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it.each([false, true])(
    "preserves stored representatives and leaves primary null (partial rename %s)",
    async (partiallyRenamed) => {
      await client.command({ query: `DROP TABLE IF EXISTS ${database}.deduped_activities` });
      await client.command({
        query: `CREATE TABLE ${database}.deduped_activities (
      activity_id UUID, user_id UUID, primary_activity_id UUID, member_activity_ids Array(UUID)
    ) ENGINE = MergeTree ORDER BY activity_id`,
      });
      await client.command({
        query: `INSERT INTO ${database}.deduped_activities VALUES
      ('${memberId}', '${memberId}', '${memberId}', ['${memberId}'])`,
      });
      if (partiallyRenamed)
        await client.command({
          query: `ALTER TABLE ${database}.deduped_activities RENAME COLUMN primary_activity_id TO representative_activity_id`,
        });
      const mapped: ClickHouseCommandClient = {
        command: async (options) => {
          // View behavior is covered by the activity model suite; exercise schema steps here.
          if (options.query.startsWith("ALTER TABLE"))
            await client.command({ query: options.query.replaceAll("analytics.", `${database}.`) });
        },
        query: async <TRow extends object>(options: { query: string; format: "JSONEachRow" }) => {
          const result = await client.query({
            query: options.query.replaceAll("database = 'analytics'", `database = '${database}'`),
            format: "JSONEachRow",
          });
          return { json: () => result.json<TRow>() };
        },
      };
      const migration = createMigration();
      if (!migration.run) throw new Error("Missing origin migration runner");
      await migration.run(mapped, "postgres://test");
      await migration.run(mapped, "postgres://test");
      const result = await client.query({
        query: `SELECT toString(primary_activity_id) AS primary,
      toString(representative_activity_id) AS representative, primary_provider_id AS provider FROM ${database}.deduped_activities`,
        format: "JSONEachRow",
      });
      expect(
        z
          .array(
            z.object({
              primary: z.string().nullable(),
              representative: z.string(),
              provider: z.string().nullable(),
            }),
          )
          .parse(await result.json()),
      ).toEqual([{ primary: null, representative: memberId, provider: null }]);
    },
  );
});
