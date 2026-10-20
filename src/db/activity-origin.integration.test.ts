import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
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

describe("PostgreSQL provenance-only origin", () => {
  let context: Awaited<ReturnType<typeof setupTestDatabase>>;
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    if (context) await context.cleanup();
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
            ]).has(key),
        ),
      );
    const before = await read();
    expect(before.primary_activity_id).toBeNull();
    await context.db.execute(sql`UPDATE fitness.activity SET raw='{}' WHERE id=${copyId}`);
    const after = await read();
    expect(after.primary_activity_id).toBe(originalId);
    expect(fields(after)).toEqual(fields(before));
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
