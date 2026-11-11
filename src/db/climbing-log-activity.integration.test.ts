import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { persistClimbingLogSnapshot } from "./climbing-log-snapshot.ts";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import { activity } from "./schema/activity.ts";
import { climbingAttempt, climbingLogEntry } from "./schema/climbing.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("native climbing log activity observations", () => {
  let context: TestContext;
  let userId: string;
  const providerId = "kilter";
  const source: SourceClimbingLogEntry = {
    externalId: "kilter:log:one",
    sourceName: "Kilter Board",
    climbedOn: null,
    board: { name: "Kilter Board", externalId: "board-one" },
    activityObservation: { recordedAt: "2026-11-10T01:48:51.544Z", gymExternalId: "gym-one" },
    raw: { logUuid: "one", createdAt: "2026-11-10T01:48:51.544Z", attempts: 1 },
    attempts: [{ scope: "climb", sourceCompleted: true }],
  };
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES (${providerId}, 'Kilter Board') ON CONFLICT (id) DO NOTHING`);
  });
  beforeEach(async () => {
    userId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Climbing observation test')`);
  });
  afterAll(async () => {
    await context.cleanup();
  });
  const write = (entries: readonly SourceClimbingLogEntry[] = [source]) =>
    persistClimbingLogSnapshot(context.db, { userId, providerId, entries });
  const points = () => context.db.select().from(activity).where(eq(activity.userId, userId));
  const logs = () =>
    context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.userId, userId));

  it("persists the raw instant and canonical association with stable log, activity and attempt IDs", async () => {
    await write();
    const before = await points();
    expect(before).toEqual([
      expect.objectContaining({
        userId,
        providerId,
        externalId: source.externalId,
        canonicalType: "climbing",
        providerType: "climbing_log",
        startedAt: new Date("2026-11-10T01:48:51.544Z"),
        endedAt: null,
        raw: { gymExternalId: "gym-one" },
        sourceName: "Kilter Board",
      }),
    ]);
    const entries = await logs();
    expect(entries).toEqual([
      expect.objectContaining({ activityId: before[0]?.id, raw: source.raw, climbedOn: null }),
    ]);
    const attempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, entries[0]?.id ?? ""));
    expect(attempts).toHaveLength(1);
    await write();
    expect(await points()).toEqual(before);
    expect(await logs()).toEqual(entries);
    expect(
      await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, entries[0]?.id ?? "")),
    ).toEqual(attempts);
  });

  it("uses the configured geographic home zone rather than the timestamp's UTC serialization", async () => {
    await context.db.execute(sql`INSERT INTO fitness.user_settings (user_id, key, value)
      VALUES (${userId}, 'homeTimezone', '"America/Los_Angeles"'::jsonb)`);
    await write();
    expect(await points()).toEqual([
      expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -480,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: null,
      }),
    ]);
  });

  async function recordedActivity() {
    const [row] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId,
        externalId: randomUUID(),
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-11-10T01:00:00Z"),
        endedAt: new Date("2026-11-10T02:00:00Z"),
      })
      .returning();
    if (!row) throw new Error("Expected recorded workout");
    return row;
  }

  it("preserves an explicit attachment without creating another activity", async () => {
    const recorded = await recordedActivity();
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId,
      entries: [{ externalId: source.externalId, activityId: recorded.id, attempts: [] }],
    });
    await write();
    expect((await logs())[0]?.activityId).toBe(recorded.id);
    expect(await points()).toHaveLength(1);
  });

  it("retires the prior standalone point after manual attachment without claiming vendor absence", async () => {
    await write();
    const point = (await points())[0];
    const recorded = await recordedActivity();
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: recorded.id })
      .where(eq(climbingLogEntry.userId, userId));
    await write();
    expect((await logs())[0]?.activityId).toBe(recorded.id);
    expect(await points()).toContainEqual(
      expect.objectContaining({
        id: point?.id,
        deletedAt: expect.any(Date),
        providerAbsentAt: null,
      }),
    );
  });

  it("reconciles authoritative removal and restoration while preserving user deletion and raw identities", async () => {
    await write([source, { ...source, externalId: "kilter:log:two" }]);
    const before = await points();
    const deleted = before.find((row) => row.externalId === "kilter:log:two");
    if (!deleted) throw new Error("Expected second point");
    const deletedAt = new Date("2026-11-11T00:00:00Z");
    await context.db.update(activity).set({ deletedAt }).where(eq(activity.id, deleted.id));
    await write([]);
    expect(await points()).toContainEqual(
      expect.objectContaining({
        externalId: source.externalId,
        providerAbsentAt: expect.any(Date),
      }),
    );
    expect((await logs()).every((row) => row.providerAbsentAt instanceof Date)).toBe(true);
    await write([source, { ...source, externalId: "kilter:log:two" }]);
    expect((await points()).map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );
    expect(await points()).toContainEqual(expect.objectContaining({ id: deleted.id, deletedAt }));
    expect(await points()).toContainEqual(
      expect.objectContaining({ externalId: source.externalId, providerAbsentAt: null }),
    );
    await write([{ ...source, externalId: "kilter:log:two" }]);
    expect(await points()).toContainEqual(
      expect.objectContaining({
        externalId: source.externalId,
        providerAbsentAt: expect.any(Date),
      }),
    );
  });

  it("leaves history unchanged when observation validation rejects a source snapshot", async () => {
    await write();
    const before = await points();
    const entries = await logs();
    await expect(
      write([{ ...source, activityObservation: { recordedAt: "not-a-timestamp" } }]),
    ).rejects.toThrow();
    expect(await points()).toEqual(before);
    expect(await logs()).toEqual(entries);
  });

  it("keeps date-only writers as log records without point activities", async () => {
    await write([{ externalId: "date-only", climbedOn: "2026-11-09", attempts: [] }]);
    expect(await points()).toEqual([]);
    expect(await logs()).toEqual([
      expect.objectContaining({ activityId: null, climbedOn: "2026-11-09" }),
    ]);
  });
});
