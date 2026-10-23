import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMigration } from "./clickhouse-migrations/0105_activity_absence_provider.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "./clickhouse-raw-tables.ts";

const fixtureSchema = z.object({
  name: z.string(),
  members: z.array(
    z.object({
      id: z.string().uuid(),
      providerId: z.string(),
      externalId: z.string().optional(),
      sourceName: z.string().nullable(),
      raw: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  expectedPrimaryMemberId: z.string().nullable(),
  expectedCandidateMemberIds: z.array(z.string()),
});
const fixtures = z
  .array(fixtureSchema)
  .parse(
    JSON.parse(
      readFileSync(new URL("../test-fixtures/activity-origin.json", import.meta.url), "utf8"),
    ),
  );
const groupId = "00000000-0000-4000-8000-000000000100";
const userId = "00000000-0000-4000-8000-000000000200";

function originQuery(selectSql: string): string {
  const macro = readFileSync(
    new URL("../../analytics/macros/activity_origin.sql", import.meta.url),
    "utf8",
  );
  const body = macro.match(/\{% macro activity_origin\(\) %\}([\s\S]*?)\{% endmacro %\}/)?.[1];
  if (!body) throw new Error("Missing activity origin macro");
  return `WITH ranked AS (
    SELECT toUUID(JSONExtractString(member, 'activity_id')) AS activity_id,
      toUUID(JSONExtractString(member, 'user_id')) AS user_id,
      toUUID(JSONExtractString(member, 'group_id')) AS group_id,
      JSONExtractString(member, 'provider_id') AS provider_id,
      JSONExtract(member, 'external_id', 'Nullable(String)') AS external_id,
      JSONExtract(member, 'source_name', 'Nullable(String)') AS source_name,
      JSONExtract(member, 'raw', 'Nullable(String)') AS raw
    FROM (SELECT arrayJoin(JSONExtractArrayRaw({members:String})) AS member)
  ), ${body} SELECT ${selectSql}`;
}

describe("ClickHouse provenance-only origin", () => {
  const client = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    request_timeout: 2000,
  });
  beforeAll(async () => {
    await client.query({ query: "SELECT 1" });
  });
  afterAll(async () => {
    await client.close();
  });

  it("preserves absence and deletion fields when a migrated table is copied to a fresh table", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const migrated = `activity_migrated_${suffix}`;
    const fresh = `activity_fresh_${suffix}`;
    try {
      await client.command({
        query: buildPostgresFitnessActivityRawTableStatement({ tableName: migrated }).replace(
          "  absence_provider_id Nullable(String),\n",
          "",
        ),
      });
      for (const statement of createMigration().statements) {
        await client.command({ query: statement.replace("postgres_fitness.activity", migrated) });
      }
      await client.command({
        query: buildPostgresFitnessActivityRawTableStatement({ tableName: fresh }),
      });
      await client.insert({
        table: migrated,
        format: "JSONEachRow",
        values: [
          {
            id: randomUUID(),
            user_id: userId,
            provider_id: "peloton",
            absence_provider_id: "whoop",
            provider_absent_at: "2026-10-22 01:00:00",
            deleted_at: "2026-10-22 02:00:00",
            group_id: groupId,
          },
        ],
      });
      await client.command({ query: `INSERT INTO ${fresh} SELECT * FROM ${migrated}` });
      const result = await client.query({
        query: `SELECT absence_provider_id, toString(provider_absent_at) AS absent_at,
          toString(deleted_at) AS deleted_at, toString(group_id) AS group_id FROM ${fresh}`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([
        {
          absence_provider_id: "whoop",
          absent_at: "2026-10-22 01:00:00.000000",
          deleted_at: "2026-10-22 02:00:00.000000",
          group_id: groupId,
        },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${fresh}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${migrated}` });
    }
  });

  it.each(fixtures)("$name", async (fixture) => {
    const rows = fixture.members.map((member) => ({
      activity_id: member.id,
      user_id: userId,
      group_id: groupId,
      provider_id: member.providerId,
      external_id: member.externalId ?? null,
      source_name: member.sourceName,
      raw: member.raw === null ? null : JSON.stringify(member.raw),
    }));
    const data = JSON.stringify(rows);
    const query = originQuery(
      "toString(primary_activity_id) AS primary, arrayMap(member -> toString(member), origin_candidate_member_ids) AS candidates FROM activity_origins",
    );
    const result = await client.query({
      query,
      query_params: { members: data },
      format: "JSONEachRow",
    });
    expect(
      z
        .array(z.object({ primary: z.string().nullable(), candidates: z.array(z.string()) }))
        .parse(await result.json()),
    ).toEqual([
      { primary: fixture.expectedPrimaryMemberId, candidates: fixture.expectedCandidateMemberIds },
    ]);
  });

  it("returns a nullable copy provider only when explicit upstream identity exists", async () => {
    const rows = [
      {
        activity_id: "00000000-0000-4000-8000-000000000001",
        provider_id: "peloton",
        raw: JSON.stringify({ platform: "home_bike", deviceType: "bike" }),
      },
      {
        activity_id: "00000000-0000-4000-8000-000000000002",
        provider_id: "peloton",
        raw: JSON.stringify({ platform: "whoop", deviceType: "whoop" }),
      },
    ].map((row) => ({
      ...row,
      user_id: userId,
      group_id: groupId,
      external_id: "c4e019f3387447ad8a2420e7c7918cf5",
      source_name: null,
    }));
    const result = await client.query({
      query: originQuery("copy_provider FROM origin_labels ORDER BY activity_id"),
      query_params: { members: JSON.stringify(rows) },
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ copy_provider: null }, { copy_provider: "whoop" }]);
  });
});
