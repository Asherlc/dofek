import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { ClimbingLogEntryAssociator } from "./climbing-log-entry-associator.ts";

const otherUser = "a0000000-0000-4000-8000-000000000001";
describe("ClimbingLogEntryAssociator PostgreSQL behavior", () => {
  let context: TestContext;
  let memberId: string,
    groupId: string,
    localId: string,
    foreignId: string,
    adjacentId: string,
    concurrentId: string,
    hikingId: string,
    runningId: string;
  const repo = () => new ClimbingLogEntryAssociator(context.db, userId, "America/Los_Angeles");
  async function log(
    externalId: string,
    day: string,
    owner = userId,
    source: Partial<SourceClimbingLogEntry> = {},
  ) {
    const result = await persistClimbingLogEntries(context.db, {
      userId: owner,
      providerId: "openbeta",
      entries: [{ externalId, climbedOn: day, attempts: [{ scope: "climb" }], ...source }],
    });
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected fixture log");
    return id;
  }
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES (${otherUser}::uuid,'Other climber')`,
    );
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, otherUser);
    const rows = await context.db
      .insert(activity)
      .values([
        {
          userId,
          providerId: "openbeta",
          externalId: "climbing",
          canonicalType: "climbing",
          providerType: "climbing",
          startedAt: new Date("2026-01-02T00:30:00Z"),
        },
        {
          userId,
          providerId: "openbeta",
          externalId: "hiking",
          canonicalType: "hiking",
          providerType: "hiking",
          startedAt: new Date("2026-01-02T00:30:00Z"),
        },
        {
          userId,
          providerId: "openbeta",
          externalId: "running",
          canonicalType: "running",
          providerType: "running",
          startedAt: new Date("2026-01-02T00:30:00Z"),
        },
      ])
      .returning();
    const climbing = rows.find((row) => row.externalId === "climbing"),
      hiking = rows.find((row) => row.externalId === "hiking"),
      running = rows.find((row) => row.externalId === "running");
    if (!climbing?.groupId || !hiking?.groupId || !running?.groupId)
      throw new Error("Expected fixture activity groups");
    memberId = climbing.id;
    groupId = climbing.groupId;
    hikingId = hiking.groupId;
    runningId = running.groupId;
    localId = await log("same-day", "2026-01-01");
    adjacentId = await log("adjacent", "2026-01-02");
    foreignId = await log("foreign", "2026-01-01", otherUser);
    concurrentId = await log("concurrent", "2026-01-01");
    const absent = await log("absent", "2026-01-01");
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, absent));
    await log("undated", "2026-01-01", userId, { climbedOn: null });
  });
  afterAll(async () => {
    await context.cleanup();
  });
  it("suggests active owned logs on the displayed local day including unclassified logs", async () => {
    expect((await repo().getSuggestions(groupId)).map((log) => log.id).sort()).toEqual(
      [localId, concurrentId].sort(),
    );
    expect(await repo().getSuggestions(groupId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: localId,
          climbedOn: "2026-01-01",
          climb: null,
          recordedClimbAttemptCount: 1,
        }),
      ]),
    );
  });
  it("attaches to the real group member while preserving the source day", async () => {
    await repo().attachLogEntry({ climbingLogEntryId: localId, activityId: groupId });
    expect(
      await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.id, localId)),
    ).toEqual([expect.objectContaining({ activityId: memberId, climbedOn: "2026-01-01" })]);
    await expect(
      repo().attachLogEntry({ climbingLogEntryId: localId, activityId: groupId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("allows only one concurrent attachment", async () => {
    const results = await Promise.allSettled([
      repo().attachLogEntry({ climbingLogEntryId: concurrentId, activityId: groupId }),
      repo().attachLogEntry({ climbingLogEntryId: concurrentId, activityId: groupId }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
    ]);
  });
  it("rejects adjacent days foreign owners unavailable activities and incompatible activity types", async () => {
    await expect(
      repo().attachLogEntry({ climbingLogEntryId: adjacentId, activityId: groupId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      repo().attachLogEntry({ climbingLogEntryId: foreignId, activityId: groupId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      repo().getSuggestions("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repo().attachLogEntry({ climbingLogEntryId: adjacentId, activityId: runningId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(repo().getSuggestions(runningId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
  it("allows a mountaineering log to attach to a hiking outing", async () => {
    const id = await log("summit", "2026-01-01", userId, {
      discipline: "mountaineering",
      climb: { externalId: "summit", kind: "summit" },
      attempts: [{ scope: "climb", outcome: "completed" }],
    });
    expect(await repo().getSuggestions(hikingId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, discipline: "mountaineering" })]),
    );
    await repo().attachLogEntry({ climbingLogEntryId: id, activityId: hikingId });
    expect(
      await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.id, id)),
    ).toEqual([
      expect.objectContaining({ activityId: expect.any(String), climbedOn: "2026-01-01" }),
    ]);
  });
});
