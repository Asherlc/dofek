import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

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

  it.each(fixtures)("$name", async (fixture) => {
    const macro = readFileSync(
      new URL("../../analytics/macros/activity_origin.sql", import.meta.url),
      "utf8",
    );
    const body = macro.match(/\{% macro activity_origin\(\) %\}([\s\S]*?)\{% endmacro %\}/)?.[1];
    if (!body) throw new Error("Missing activity origin macro");
    const rows = fixture.members.map((member) => ({
      activity_id: member.id,
      user_id: userId,
      group_id: groupId,
      provider_id: member.providerId,
      external_id: member.externalId ?? "",
      source_name: member.sourceName,
      raw: member.raw === null ? null : JSON.stringify(member.raw),
    }));
    const data = JSON.stringify(rows);
    const query = `WITH ranked AS (
      SELECT toUUID(JSONExtractString(member, 'activity_id')) AS activity_id,
        toUUID(JSONExtractString(member, 'user_id')) AS user_id,
        toUUID(JSONExtractString(member, 'group_id')) AS group_id,
        JSONExtractString(member, 'provider_id') AS provider_id,
        JSONExtractString(member, 'external_id') AS external_id,
        JSONExtract(member, 'source_name', 'Nullable(String)') AS source_name,
        JSONExtract(member, 'raw', 'Nullable(String)') AS raw
      FROM (SELECT arrayJoin(JSONExtractArrayRaw({members:String})) AS member)
    ), ${body}
    SELECT toString(primary_activity_id) AS primary, arrayMap(member -> toString(member), origin_candidate_member_ids) AS candidates FROM activity_origins`;
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
});
