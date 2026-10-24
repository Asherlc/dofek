import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "./execute-with-schema.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase } from "./test-helpers.ts";

const cases = z
  .array(
    z.object({
      name: z.string(),
      members: z.array(
        z.object({
          id: z.string(),
          providerId: z.string(),
          externalId: z.string().optional(),
          sourceName: z.string().nullable(),
          raw: z.record(z.string(), z.unknown()).nullable(),
        }),
      ),
      expectedPrimaryMemberId: z.string().nullable(),
      expectedCandidateMemberIds: z.array(z.string()),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(new URL("../test-fixtures/activity-origin.json", import.meta.url), "utf8"),
    ),
  );

const originSchema = z.object({
  primary_activity_id: z.string().nullable(),
  primary_provider_id: z.string().nullable(),
  primary_source_name: z.string().nullable(),
  origin_candidate_member_ids: z.array(z.string()),
  origin_evidence: z.array(z.record(z.string(), z.unknown())),
});
const firstMemberId = "00000000-0000-4000-8000-000000000001";
const secondMemberId = "00000000-0000-4000-8000-000000000002";
const thirdMemberId = "00000000-0000-4000-8000-000000000003";
const unresolvedOrigin = {
  primary_activity_id: null,
  primary_provider_id: null,
  primary_source_name: null,
  origin_candidate_member_ids: [firstMemberId, secondMemberId],
  origin_evidence: [],
};
const fixtureMembers = (name: string) => {
  const fixture = cases.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing origin fixture: ${name}`);
  return fixture.members;
};
const whoopMembers = fixtureMembers("WHOOP workout propagated to Peloton");
const missingMembers = fixtureMembers("missing provenance");
const viewCases = [
  {
    name: "source bundle and source name transfer chain",
    members: fixtureMembers("complete transfer chain"),
    expected: {
      primary_activity_id: firstMemberId,
      primary_provider_id: "garmin",
      primary_source_name: "Garmin Edge 530",
      origin_candidate_member_ids: [firstMemberId],
      origin_evidence: [
        {
          upstreamMemberActivityId: firstMemberId,
          downstreamMemberActivityId: secondMemberId,
          field: "source_name",
          value: "garmin edge 530",
        },
        {
          upstreamMemberActivityId: secondMemberId,
          downstreamMemberActivityId: thirdMemberId,
          field: "raw.sourceBundle",
          value: "com.strava.strava",
        },
      ],
    },
  },
  {
    name: "device name transfer",
    members: [
      { id: firstMemberId, providerId: "garmin", sourceName: null, raw: null },
      {
        id: secondMemberId,
        providerId: "strava",
        sourceName: null,
        raw: { device_name: "  Garmin Edge 530  " },
      },
    ],
    expected: {
      primary_activity_id: firstMemberId,
      primary_provider_id: "garmin",
      primary_source_name: null,
      origin_candidate_member_ids: [firstMemberId],
      origin_evidence: [
        {
          upstreamMemberActivityId: firstMemberId,
          downstreamMemberActivityId: secondMemberId,
          field: "raw.device_name",
          value: "garmin edge 530",
        },
      ],
    },
  },
  {
    name: "platform and device type transfer",
    members: whoopMembers,
    expected: {
      primary_activity_id: firstMemberId,
      primary_provider_id: "whoop",
      primary_source_name: null,
      origin_candidate_member_ids: [firstMemberId],
      origin_evidence: [
        {
          upstreamMemberActivityId: firstMemberId,
          downstreamMemberActivityId: secondMemberId,
          field: "external_id",
          value: "c4e019f3387447ad8a2420e7c7918cf5",
        },
      ],
    },
  },
  ...["platform", "deviceType"].map((field) => ({
    name: `JSON-null ${field} cannot establish a transfer`,
    members: whoopMembers.map((member) => ({
      ...member,
      raw: member.providerId === "peloton" ? { ...member.raw, [field]: null } : member.raw,
    })),
    expected: unresolvedOrigin,
  })),
  {
    name: "JSON-null source bundle cannot establish a transfer",
    members: [
      { id: firstMemberId, providerId: "strava", sourceName: null, raw: null },
      {
        id: secondMemberId,
        providerId: "apple_health",
        sourceName: null,
        raw: { sourceBundle: null },
      },
    ],
    expected: unresolvedOrigin,
  },
  {
    name: "conflicting source bundle",
    members: fixtureMembers("conflicting Apple Health source bundle"),
    expected: {
      ...unresolvedOrigin,
      origin_candidate_member_ids: [firstMemberId, secondMemberId, thirdMemberId],
      origin_evidence: [
        {
          upstreamMemberActivityId: firstMemberId,
          downstreamMemberActivityId: secondMemberId,
          field: "source_name",
          value: "garmin edge 530",
        },
      ],
    },
  },
  {
    name: "SQL-null raw metadata",
    members: missingMembers,
    expected: unresolvedOrigin,
  },
  {
    name: "missing metadata keys",
    members: missingMembers.map((member) => ({ ...member, raw: {} })),
    expected: unresolvedOrigin,
  },
  {
    name: "JSON-null metadata keys",
    members: missingMembers.map((member) => ({
      ...member,
      raw: { sourceBundle: null, device_name: null, platform: null, deviceType: null },
    })),
    expected: unresolvedOrigin,
  },
];

describe("PostgreSQL provenance-only origin", () => {
  let context: Awaited<ReturnType<typeof setupTestDatabase>>;
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    if (context) await context.cleanup();
  });

  it("bounds resolver input independently of the full public vendor payload", async () => {
    const groupId = randomUUID();
    const memberId = randomUUID();
    const raw = { sourceBundle: "com.strava.strava", vendorBody: "x".repeat(64 * 1024) };
    await context.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES ('apple_health','Apple Health') ON CONFLICT(id) DO NOTHING`,
    );
    await context.db.execute(sql`INSERT INTO fitness.activity(id,group_id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,raw) VALUES
      (${memberId},${groupId},${TEST_USER_ID},'apple_health',${memberId},'cycling','cycling','2026-10-03T10:00:00Z',${JSON.stringify(raw)}::jsonb)`);
    const [original] = await executeWithSchema(
      context.db,
      z.object({ definition: z.string() }),
      sql`SELECT pg_get_functiondef('fitness.resolve_activity_origin(jsonb)'::regprocedure) AS definition`,
    );
    if (!original) throw new Error("Missing origin resolver definition");
    try {
      await context.db.execute(
        sql.raw(
          original.definition.replace(
            "fitness.resolve_activity_origin(",
            "fitness.test_resolve_activity_origin(",
          ),
        ),
      );
      await context.db.execute(
        sql`CREATE TABLE fitness.test_origin_input (members jsonb NOT NULL)`,
      );
      // Preserve the function identity referenced by v_activity and delegate to its real body.
      await context.db.execute(sql`CREATE OR REPLACE FUNCTION fitness.resolve_activity_origin(input_members jsonb)
        RETURNS TABLE (primary_activity_id uuid, primary_provider_id text, primary_source_name text,
          origin_candidate_member_ids uuid[], origin_evidence jsonb)
        LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE AS $$
        BEGIN
          INSERT INTO fitness.test_origin_input(members) VALUES (input_members);
          RETURN QUERY SELECT * FROM fitness.test_resolve_activity_origin(input_members);
        END;
        $$`);
      const rows = await executeWithSchema(
        context.db,
        originSchema.extend({ raw: z.record(z.string(), z.unknown()) }),
        sql`SELECT primary_activity_id,primary_provider_id,primary_source_name,
          origin_candidate_member_ids,origin_evidence,raw FROM fitness.v_activity WHERE id=${groupId}`,
      );
      expect(rows).toEqual([
        {
          primary_activity_id: memberId,
          primary_provider_id: "apple_health",
          primary_source_name: null,
          origin_candidate_member_ids: [memberId],
          origin_evidence: [],
          raw,
        },
      ]);
      const observed = await executeWithSchema(
        context.db,
        z.object({ input_bytes: z.number() }),
        sql`SELECT octet_length(members::text) AS input_bytes FROM fitness.test_origin_input
          WHERE members @> ${JSON.stringify([{ id: memberId }])}::jsonb`,
      );
      expect(observed.length).toBeGreaterThan(0);
      for (const input of observed) expect(input.input_bytes).toBeLessThan(1024);
    } finally {
      await context.db.execute(sql.raw(original.definition));
      await context.db.execute(
        sql`DROP FUNCTION IF EXISTS fitness.test_resolve_activity_origin(jsonb)`,
      );
      await context.db.execute(sql`DROP TABLE IF EXISTS fitness.test_origin_input`);
      await context.db.execute(sql`DELETE FROM fitness.activity WHERE group_id=${groupId}`);
      await context.db.execute(sql`DELETE FROM fitness.activity_group WHERE id=${groupId}`);
    }
  });

  it.each(viewCases)("preserves every origin column through v_activity: $name", async (fixture) => {
    const groupId = randomUUID();
    try {
      for (const member of fixture.members) {
        await context.db.execute(sql`INSERT INTO fitness.provider(id,name) VALUES
          (${member.providerId},${member.providerId}) ON CONFLICT(id) DO NOTHING`);
        await context.db.execute(sql`INSERT INTO fitness.activity(id,group_id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,source_name,raw) VALUES
          (${member.id},${groupId},${TEST_USER_ID},${member.providerId},${"externalId" in member ? member.externalId : member.id},'cycling','cycling','2026-10-04T10:00:00Z',${member.sourceName},${member.raw === null ? null : JSON.stringify(member.raw)}::jsonb)`);
      }
      const rows = await executeWithSchema(
        context.db,
        originSchema,
        sql`SELECT primary_activity_id,primary_provider_id,primary_source_name,
          origin_candidate_member_ids,origin_evidence FROM fitness.v_activity WHERE id=${groupId}`,
      );
      expect(rows).toEqual([fixture.expected]);
    } finally {
      await context.db.execute(sql`DELETE FROM fitness.activity WHERE group_id=${groupId}`);
      await context.db.execute(sql`DELETE FROM fitness.activity_group WHERE id=${groupId}`);
    }
  });

  it("changes provenance without changing selected fields, and changes field preference without changing origin", async () => {
    const groupId = "00000000-0000-4000-8000-000000000300";
    const originalId = "00000000-0000-4000-8000-000000000301";
    const copyId = "00000000-0000-4000-8000-000000000302";
    await context.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES ('garmin','Garmin'),('apple_health','Apple Health'),('strava','Strava') ON CONFLICT(id) DO NOTHING`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider_priority(provider_id,priority) VALUES ('garmin',0),('apple_health',10) ON CONFLICT(provider_id) DO UPDATE SET priority=excluded.priority`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.activity_group(id,user_id) VALUES (${groupId},${TEST_USER_ID})`,
    );
    await context.db.execute(sql`INSERT INTO fitness.activity(id,group_id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,ended_at,name,source_name,raw) VALUES
      (${originalId},${groupId},${TEST_USER_ID},'garmin','origin-invariance','cycling','cycling','2026-10-01T10:00:00Z','2026-10-01T11:00:00Z','Original title','Garmin Edge 530','{"stable":true}'),
      (${copyId},${groupId},${TEST_USER_ID},'apple_health','copy-invariance','cycling','cycling','2026-10-01T10:00:00Z','2026-10-01T11:00:00Z','Edited title','Garmin','{"sourceBundle":"com.strava.strava"}')`);
    const read = async () => {
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .parse(await context.db.execute(sql`SELECT * FROM fitness.v_activity WHERE id=${groupId}`));
      if (!rows[0]) throw new Error("Missing group");
      return rows[0];
    };
    const fields = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !new Set([
              "primary_activity_id",
              "primary_provider_id",
              "primary_source_name",
              "origin_candidate_member_ids",
              "origin_evidence",
              "raw",
            ]).has(key),
        ),
      );
    const before = await read();
    expect(before.primary_activity_id).toBeNull();
    await context.db.execute(sql`UPDATE fitness.activity SET raw='{}' WHERE id=${copyId}`);
    const after = await read();
    expect(after.primary_activity_id).toBe(originalId);
    expect(fields(after)).toEqual(fields(before));
    expect(before.raw).toMatchObject({ sourceBundle: "com.strava.strava", stable: true });
    expect(after.raw).toEqual({ stable: true });
    await context.db.execute(sql`INSERT INTO fitness.provider_field_priority(provider_id,field_key,priority) VALUES
      ('apple_health','activity.name',0),('garmin','activity.name',100)
      ON CONFLICT(provider_id,field_key) DO UPDATE SET priority=excluded.priority`);
    const preferredField = await read();
    expect(preferredField.name).toBe("Edited title");
    expect(preferredField.primary_activity_id).toBe(originalId);
  });

  it("replaces HealthKit revisions and re-resolves source removal without crossing groups", async () => {
    const groupId = "00000000-0000-4000-8000-000000000400";
    const originalId = "00000000-0000-4000-8000-000000000401";
    const oldCopyId = "00000000-0000-4000-8000-000000000402";
    const newCopyId = "00000000-0000-4000-8000-000000000403";
    await context.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES ('strava','Strava'),('apple_health','Apple Health') ON CONFLICT(id) DO NOTHING`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.activity_group(id,user_id) VALUES (${groupId},${TEST_USER_ID})`,
    );
    await context.db.execute(sql`INSERT INTO fitness.activity(id,group_id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,ended_at,source_name,raw) VALUES
      (${originalId},${groupId},${TEST_USER_ID},'strava','origin-revision','cycling','cycling','2026-10-02T10:00:00Z','2026-10-02T11:00:00Z','Garmin Edge 530','{}'),
      (${oldCopyId},${groupId},${TEST_USER_ID},'apple_health','copy-revision-1','cycling','cycling','2026-10-02T10:00:00Z','2026-10-02T11:00:00Z','Strava','{"metadata":{"HKMetadataKeySyncIdentifier":"origin-revision","HKMetadataKeySyncVersion":1}}')`);
    const read = async () => {
      const rows = z
        .array(
          z.object({
            id: z.string(),
            primary_activity_id: z.string().nullable(),
            member_activity_ids: z.array(z.string()),
          }),
        )
        .parse(
          await context.db.execute(
            sql`SELECT id,primary_activity_id,member_activity_ids::text[] FROM fitness.v_activity WHERE id=${groupId}`,
          ),
        );
      if (!rows[0]) throw new Error("Missing group");
      return rows[0];
    };
    expect((await read()).primary_activity_id).toBe(originalId);
    await context.db.execute(sql`INSERT INTO fitness.activity(id,group_id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,ended_at,source_name,raw) VALUES
      (${newCopyId},${groupId},${TEST_USER_ID},'apple_health','copy-revision-2','cycling','cycling','2026-10-02T10:00:00Z','2026-10-02T11:00:00Z','Strava','{"metadata":{"HKMetadataKeySyncIdentifier":"origin-revision","HKMetadataKeySyncVersion":2}}')`);
    expect(await read()).toEqual({
      id: groupId,
      primary_activity_id: originalId,
      member_activity_ids: [originalId, newCopyId],
    });
    await context.db.execute(
      sql`UPDATE fitness.activity SET deleted_at=now() WHERE id=${originalId}`,
    );
    expect(await read()).toEqual({
      id: groupId,
      primary_activity_id: newCopyId,
      member_activity_ids: [newCopyId],
    });
  });
  it.each(cases)("$name", async (fixture) => {
    const rows = await context.db.execute(sql`SELECT primary_activity_id::text AS primary,
      origin_candidate_member_ids::text[] AS candidates
      FROM fitness.resolve_activity_origin(${JSON.stringify(fixture.members)}::jsonb)`);
    expect(
      z
        .array(z.object({ primary: z.string().nullable(), candidates: z.array(z.string()) }))
        .parse(rows),
    ).toEqual([
      { primary: fixture.expectedPrimaryMemberId, candidates: fixture.expectedCandidateMemberIds },
    ]);
  });
});
