import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogSessions } from "./climbing-log-session-sync.ts";
import type { SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import { activity } from "./schema/activity.ts";
import { climbingAttempt, climbingLogEntry } from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("authoritative climbing log sessions", () => {
  let context: TestContext;
  let activityId: string;
  const providerId = "climbing-session-test";
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name) VALUES (${providerId}, 'Climbing session test')`,
    );
    const [row] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId,
        externalId: "session-one",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        startedAt: new Date("2026-10-01T12:00:00Z"),
      })
      .returning();
    if (!row) throw new Error("Expected session activity");
    activityId = row.id;
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry).where(eq(climbingLogEntry.providerId, providerId));
  });
  afterAll(async () => {
    await context.cleanup();
  });
  function write(entries: readonly SourceClimbingLogEntry[], complete: boolean) {
    return persistClimbingLogSessions(context.db, {
      userId: TEST_USER_ID,
      providerId,
      standaloneEntries: [],
      sessions: [{ activityId, entries, complete }],
    });
  }
  async function retained() {
    return context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, providerId))
      .orderBy(climbingLogEntry.externalId);
  }
  it("preserves records after incomplete session discovery", async () => {
    await write(
      [
        { externalId: "session:one", attempts: [{ scope: "climb" as const }] },
        { externalId: "session:two", attempts: [{ scope: "climb" as const }] },
      ],
      true,
    );
    const before = await retained();
    await write(
      [
        {
          externalId: "session:one",
          notes: "Partial update",
          attempts: [{ scope: "climb" as const }],
        },
      ],
      false,
    );
    expect((await retained()).map((row) => [row.id, row.providerAbsentAt])).toEqual(
      before.map((row) => [row.id, null]),
    );
    await write([], false);
    expect((await retained()).map((row) => row.providerAbsentAt)).toEqual([null, null]);
  });
  it("tombstones only absent records from an authoritative complete session", async () => {
    await write(
      [
        { externalId: "session:one", attempts: [{ scope: "climb" as const }] },
        { externalId: "session:two", attempts: [{ scope: "climb" as const }] },
      ],
      true,
    );
    const [other] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId,
        externalId: "session-other",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        startedAt: new Date("2026-10-02T12:00:00Z"),
      })
      .returning();
    if (!other) throw new Error("Expected another session");
    await persistClimbingLogSessions(context.db, {
      userId: TEST_USER_ID,
      providerId,
      standaloneEntries: [],
      sessions: [
        {
          activityId: other.id,
          entries: [{ externalId: "other:one", attempts: [{ scope: "climb" as const }] }],
          complete: true,
        },
      ],
    });
    await write([{ externalId: "session:one", attempts: [{ scope: "climb" as const }] }], true);
    expect(await retained()).toEqual([
      expect.objectContaining({ externalId: "other:one", providerAbsentAt: null }),
      expect.objectContaining({ externalId: "session:one", providerAbsentAt: null }),
      expect.objectContaining({ externalId: "session:two", providerAbsentAt: expect.any(Date) }),
    ]);
    await write([{ externalId: "session:two", attempts: [{ scope: "climb" as const }] }], true);
    expect(
      (await retained()).find((row) => row.externalId === "session:two")?.providerAbsentAt,
    ).toBeNull();
    await write([], true);
    expect(
      (await retained())
        .filter((row) => row.activityId === activityId)
        .every((row) => row.providerAbsentAt !== null),
    ).toBe(true);
  });
  it("rolls back session writes before absence reconciliation when an attempt conflicts", async () => {
    await write(
      [
        { externalId: "session:one", attempts: [{ scope: "climb" as const, notes: "Recorded" }] },
        { externalId: "session:two", attempts: [{ scope: "climb" as const }] },
      ],
      true,
    );
    const before = await retained();
    await expect(
      write(
        [
          { externalId: "session:new", attempts: [{ scope: "climb" as const }] },
          {
            externalId: "session:one",
            attempts: [
              { scope: "climb" as const, notes: "Different" },
              { scope: "climb" as const, notes: "Extra" },
            ],
            reportedAttemptCounts: [{ scope: "climb" as const, count: 1 }],
          },
        ],
        true,
      ),
    ).rejects.toThrow("recorded attempts");
    expect(await retained()).toEqual(before);
  });
  it("resolves histories across every session before interpreting Flash", async () => {
    const [other] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId,
        externalId: "flash-other",
        canonicalType: "climbing",
        providerType: "rock_climbing",
        startedAt: new Date("2026-10-03T12:00:00Z"),
      })
      .returning();
    if (!other) throw new Error("Expected other session");
    await persistClimbingLogSessions(context.db, {
      userId: TEST_USER_ID,
      providerId,
      standaloneEntries: [],
      sessions: [
        {
          activityId,
          complete: true,
          entries: [
            {
              externalId: "session:flash",
              climb: { externalId: "shared:route" },
              attempts: [{ scope: "climb" as const, qualifier: "free-flash" as const }],
            },
          ],
        },
        {
          activityId: other.id,
          complete: true,
          entries: [
            {
              externalId: "other:history",
              climb: { externalId: "shared:route" },
              attempts: [{ scope: "climb" as const }],
            },
          ],
        },
      ],
    });
    const [flash] = await context.db
      .select({ receivedBeta: climbingAttempt.receivedBeta })
      .from(climbingAttempt)
      .innerJoin(climbingLogEntry, eq(climbingLogEntry.id, climbingAttempt.climbingLogEntryId))
      .where(eq(climbingLogEntry.externalId, "session:flash"));
    expect(flash?.receivedBeta).toBeNull();
  });
});
