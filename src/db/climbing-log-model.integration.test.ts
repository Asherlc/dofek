import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "./schema/activity.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const providerId = "climbing-model-test";
const otherProviderId = "climbing-model-other";
const otherUserId = "00000000-0000-4000-8000-000000001996";
const pointTypeSchema = z.object({ type: z.string() });

describe("canonical climbing log model (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES (${providerId}, 'Climbing model test'), (${otherProviderId}, 'Other climbing source')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${otherUserId}::uuid, 'Other climbing owner')
    `);
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("round trips native points and nullable source facts", async () => {
    const [region] = await context.db
      .insert(area)
      .values({
        userId: TEST_USER_ID,
        providerId,
        name: "Recorded region",
        coordinates: { x: -122.25, y: 37.5 },
      })
      .returning();
    if (!region) throw new Error("Area insert returned no row");
    const [summit] = await context.db
      .insert(climb)
      .values({
        userId: TEST_USER_ID,
        providerId,
        name: "Recorded summit",
        kind: "summit",
        areaId: region.id,
        coordinates: { x: 0, y: 0 },
      })
      .returning();
    if (!summit) throw new Error("Climb insert returned no row");
    const [log] = await context.db
      .insert(climbingLogEntry)
      .values({ userId: TEST_USER_ID, providerId, climbId: summit.id })
      .returning();
    if (!log) throw new Error("Log insert returned no row");
    const [attempt] = await context.db
      .insert(climbingAttempt)
      .values({ climbingLogEntryId: log.id, scope: "climb" })
      .returning();

    expect(region.coordinates).toEqual({ x: -122.25, y: 37.5 });
    expect(summit).toMatchObject({ coordinates: { x: 0, y: 0 }, routeProtection: null });
    expect(log).toMatchObject({ climbedOn: null, discipline: null, activityId: null });
    expect(attempt).toMatchObject({
      attemptIndex: null,
      outcome: null,
      scope: "climb",
      pitchId: null,
      parentAttemptId: null,
      usedAid: null,
      fellOrHung: null,
      ropeMethod: null,
      solo: null,
      dabbed: null,
      receivedBeta: null,
    });
    const [storedType] = await executeWithSchema(
      context.db,
      pointTypeSchema,
      sql`SELECT pg_typeof(coordinates)::text AS type FROM fitness.area WHERE id = ${region.id}::uuid`,
    );
    expect(storedType?.type).toBe("point");
  });

  it.each([
    { x: 180.01, y: 0 },
    { x: -180.01, y: 0 },
    { x: 0, y: 90.01 },
    { x: 0, y: -90.01 },
    { x: Number.POSITIVE_INFINITY, y: 0 },
    { x: 0, y: Number.NaN },
  ])("rejects an invalid native coordinate pair %j", async (coordinates) => {
    await expect(
      context.db.insert(area).values({
        userId: TEST_USER_ID,
        providerId,
        name: "Invalid point",
        coordinates,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "area_coordinates_valid" } });
    await expect(
      context.db.insert(climb).values({ userId: TEST_USER_ID, providerId, coordinates }),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "climb_coordinates_valid" } });
  });

  it("rejects cross-owner and cross-provider object references", async () => {
    const areaId = randomUUID();
    const climbId = randomUUID();
    await context.db
      .insert(area)
      .values({ id: areaId, userId: TEST_USER_ID, providerId, name: "Owned area" });
    await context.db
      .insert(climb)
      .values({ id: climbId, userId: TEST_USER_ID, providerId, areaId });

    await expect(
      context.db
        .insert(area)
        .values({ userId: otherUserId, providerId, name: "Other owner", parentAreaId: areaId }),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "area_parent_owner_provider_fk" },
    });
    await expect(
      context.db
        .insert(climb)
        .values({ userId: TEST_USER_ID, providerId: otherProviderId, areaId }),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "climb_area_owner_provider_fk" },
    });
    await expect(
      context.db.insert(climbingLogEntry).values({ userId: otherUserId, providerId, climbId }),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "climbing_log_entry_climb_owner_provider_fk" },
    });
  });

  it("rejects a self-containing area", async () => {
    const id = randomUUID();
    await expect(
      context.db
        .insert(area)
        .values({ id, userId: TEST_USER_ID, providerId, name: "Self", parentAreaId: id }),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "area_parent_distinct" } });
  });

  it("preserves source date and attempts after physical activity deletion", async () => {
    const activityId = randomUUID();
    const logId = randomUUID();
    const attemptId = randomUUID();
    await context.db.insert(activity).values({
      id: activityId,
      userId: TEST_USER_ID,
      providerId: otherProviderId,
      externalId: randomUUID(),
      canonicalType: "hiking",
      providerType: "hiking",
      startedAt: new Date("2026-10-01T12:00:00Z"),
    });
    await context.db.insert(climbingLogEntry).values({
      id: logId,
      userId: TEST_USER_ID,
      providerId,
      activityId,
      climbedOn: "2026-10-01",
    });
    await context.db.insert(climbingAttempt).values({
      id: attemptId,
      climbingLogEntryId: logId,
      scope: "climb",
      outcome: "completed",
    });
    await context.db.delete(activity).where(eq(activity.id, activityId));

    const [retainedLog] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, logId));
    const attempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, logId));
    expect(retainedLog).toMatchObject({
      id: logId,
      userId: TEST_USER_ID,
      activityId: null,
      climbedOn: "2026-10-01",
    });
    expect(attempts.map((row) => row.id)).toEqual([attemptId]);
    expect(attempts[0]?.outcome).toBe("completed");
  });

  async function recordedRoute() {
    const climbId = randomUUID();
    const logId = randomUUID();
    const pitchId = randomUUID();
    await context.db
      .insert(climb)
      .values({ id: climbId, userId: TEST_USER_ID, providerId, kind: "route" });
    await context.db
      .insert(climbingLogEntry)
      .values({ id: logId, userId: TEST_USER_ID, providerId, climbId });
    await context.db.insert(pitch).values({ id: pitchId, climbId, number: 1 });
    return { climbId, logId, pitchId };
  }

  it("stores ordered owned grade collections and cascades only the deleted owners rows", async () => {
    const route = await recordedRoute();
    const retainedLogId = randomUUID();
    await context.db.insert(climbingLogEntry).values({
      id: retainedLogId,
      userId: TEST_USER_ID,
      providerId,
      climbId: route.climbId,
    });
    await context.db.insert(climbGrade).values([
      { climbId: route.climbId, position: 0, value: "5.12a", system: "yds" },
      { climbId: route.climbId, position: 1, value: "A3", system: "aid" },
    ]);
    await context.db
      .insert(pitchGrade)
      .values({ pitchId: route.pitchId, position: 0, value: "5.11a", system: "yds" });
    await context.db
      .insert(climbingLogEntryGrade)
      .values({ climbingLogEntryId: route.logId, position: 0, value: "5.12b", system: "yds" });
    expect(
      await context.db
        .select({
          value: climbGrade.value,
          system: climbGrade.system,
          position: climbGrade.position,
        })
        .from(climbGrade)
        .where(eq(climbGrade.climbId, route.climbId))
        .orderBy(climbGrade.position),
    ).toEqual([
      { value: "5.12a", system: "yds", position: 0 },
      { value: "A3", system: "aid", position: 1 },
    ]);
    await context.db.delete(climbingLogEntry).where(eq(climbingLogEntry.id, route.logId));
    expect(
      await context.db
        .select()
        .from(climbingLogEntryGrade)
        .where(eq(climbingLogEntryGrade.climbingLogEntryId, route.logId)),
    ).toHaveLength(0);
    expect(
      await context.db.select().from(pitchGrade).where(eq(pitchGrade.pitchId, route.pitchId)),
    ).toHaveLength(1);
    expect(
      await context.db.select().from(climbGrade).where(eq(climbGrade.climbId, route.climbId)),
    ).toHaveLength(2);
    expect(
      await context.db
        .select()
        .from(climbingLogEntry)
        .where(eq(climbingLogEntry.id, retainedLogId)),
    ).toHaveLength(1);
    await expect(
      context.db
        .insert(climbGrade)
        .values({ climbId: route.climbId, position: 2, value: " ", system: null }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects mismatched pitch targets and cross-log parents", async () => {
    const route = await recordedRoute();
    const other = await recordedRoute();
    const parentId = randomUUID();
    await context.db
      .insert(climbingAttempt)
      .values({ id: parentId, climbingLogEntryId: other.logId, scope: "climb" });
    await expect(
      context.db
        .insert(climbingAttempt)
        .values({ climbingLogEntryId: route.logId, scope: "pitch", pitchId: other.pitchId }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      context.db
        .insert(climbingAttempt)
        .values({ climbingLogEntryId: route.logId, scope: "pitch", parentAttemptId: parentId }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    const [unidentified] = await context.db
      .insert(climbingAttempt)
      .values({ climbingLogEntryId: route.logId, scope: "pitch" })
      .returning();
    expect(unidentified).toMatchObject({
      scope: "pitch",
      pitchId: null,
      parentAttemptId: null,
      attemptIndex: null,
    });
  });

  it("rejects nested pitch parents and whole-attempt pitch links on insert and update", async () => {
    const route = await recordedRoute();
    const parentId = randomUUID();
    const childId = randomUUID();
    await context.db
      .insert(climbingAttempt)
      .values({ id: parentId, climbingLogEntryId: route.logId, scope: "climb" });
    await context.db.insert(climbingAttempt).values({
      id: childId,
      climbingLogEntryId: route.logId,
      scope: "pitch",
      pitchId: route.pitchId,
      parentAttemptId: parentId,
    });
    await expect(
      context.db
        .insert(climbingAttempt)
        .values({ climbingLogEntryId: route.logId, scope: "pitch", parentAttemptId: childId }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      context.db
        .insert(climbingAttempt)
        .values({ climbingLogEntryId: route.logId, scope: "climb", pitchId: route.pitchId }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      context.db
        .update(climbingAttempt)
        .set({ scope: "pitch" })
        .where(eq(climbingAttempt.id, parentId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    const other = await recordedRoute();
    await expect(
      context.db
        .update(climbingLogEntry)
        .set({ climbId: other.climbId })
        .where(eq(climbingLogEntry.id, route.logId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      context.db.update(pitch).set({ climbId: other.climbId }).where(eq(pitch.id, route.pitchId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
