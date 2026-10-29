import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import { climb, climbingAttempt, climbingLogEntry } from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const providerId = "route-method-test";

describe("recorded climbing route methods", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name) VALUES (${providerId}, 'Route method test')
    `);
  });
  afterEach(async () => {
    if (!context) return;
    await context.db.delete(climbingLogEntry).where(eq(climbingLogEntry.providerId, providerId));
    await context.db.delete(climb).where(eq(climb.providerId, providerId));
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  function write(entries: readonly SourceClimbingLogEntry[]) {
    return persistClimbingLogEntries(context.db, { userId: TEST_USER_ID, providerId, entries });
  }
  function source(overrides: Partial<SourceClimbingLogEntry> = {}): SourceClimbingLogEntry {
    return {
      externalId: "route-log",
      climb: { externalId: "route", kind: "route" },
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
      ...overrides,
    };
  }
  async function log(externalId = "route-log") {
    const [entry] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.externalId, externalId));
    if (!entry?.climbId) throw new Error("Expected an identified test climb.");
    return { ...entry, climbId: entry.climbId };
  }
  async function recorded(logEntryId: string) {
    return context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, logEntryId));
  }

  it("preserves unknown methods on identified routes and counted occurrences", async () => {
    await write([
      source({
        attempts: [{ scope: "climb" }],
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
      }),
    ]);
    const attempts = await recorded((await log()).id);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((attempt) => attempt.ropeMethod)).toEqual([null, null, null]);
  });

  it("retains every counted route method and updates counts without spreading send evidence", async () => {
    const described: SourceClimbingLogEntry["attempts"][number] = {
      scope: "climb",
      ropeMethod: "top_rope",
      sourceResult: "Redpoint",
      qualifier: "free-send",
    };
    const counted: SourceClimbingLogEntry["attempts"][number] = {
      scope: "climb",
      ropeMethod: "top_rope",
    };
    await write([
      source({
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        attempts: [described, counted, counted],
      }),
    ]);
    const entry = await log();
    const before = await recorded(entry.id);
    expect(before).toHaveLength(3);
    expect(before.map((attempt) => attempt.ropeMethod)).toEqual([
      "top_rope",
      "top_rope",
      "top_rope",
    ]);
    expect(before.filter((attempt) => attempt.usedAid === false)).toHaveLength(1);
    expect(before.filter((attempt) => attempt.sourceResult === "Redpoint")).toHaveLength(1);
    const refreshed = { ...described, sourceResult: "Send" };
    await write([
      source({
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        attempts: [refreshed, counted, counted],
      }),
    ]);
    const afterRefresh = await recorded(entry.id);
    expect(afterRefresh.map((attempt) => attempt.id).sort()).toEqual(
      before.map((attempt) => attempt.id).sort(),
    );
    expect(afterRefresh.find((attempt) => attempt.sourceResult === "Send")?.id).toBe(
      before.find((attempt) => attempt.sourceResult === "Redpoint")?.id,
    );
    await write([
      source({
        reportedAttemptCounts: [{ scope: "climb", count: 2 }],
        attempts: [refreshed, counted],
      }),
    ]);
    const after = await recorded(entry.id);
    expect(after).toHaveLength(2);
    expect(after.every((attempt) => attempt.ropeMethod === "top_rope")).toBe(true);
    expect(after.find((attempt) => attempt.sourceResult === "Send")?.id).toBe(
      before.find((attempt) => attempt.sourceResult === "Redpoint")?.id,
    );
  });

  it("retains separately recorded methods when a count update cannot account for them", async () => {
    await write([
      source({
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        attempts: [
          { scope: "climb", ropeMethod: "top_rope", attemptIndex: 1, notes: "Recorded try" },
          { scope: "climb", ropeMethod: "top_rope" },
          { scope: "climb", ropeMethod: "lead" },
        ],
      }),
    ]);
    await expect(
      write([
        source({
          reportedAttemptCounts: [{ scope: "climb", count: 2 }],
          attempts: [
            { scope: "climb", ropeMethod: "top_rope", attemptIndex: 1, notes: "Recorded try" },
            { scope: "climb", ropeMethod: "top_rope" },
          ],
        }),
      ]),
    ).rejects.toThrow("Source count is below its described recorded attempts.");
    expect(await recorded((await log()).id)).toHaveLength(3);
  });

  it("retains unknown methods on counted bouldering attempts", async () => {
    await write([
      source({
        climb: { externalId: "boulder", kind: "boulder" },
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        attempts: [{ scope: "climb" }],
      }),
    ]);
    const attempts = await recorded((await log()).id);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.ropeMethod === null)).toBe(true);
  });

  it("preserves omitted methods and clears explicitly unknown methods on refresh", async () => {
    await write([source()]);
    const entry = await log();
    await write([{ externalId: "route-log", attempts: [{ scope: "climb", notes: "Updated" }] }]);
    expect((await recorded(entry.id))[0]?.ropeMethod).toBe("lead");
    await write([{ externalId: "route-log", attempts: [{ scope: "climb", ropeMethod: null }] }]);
    expect((await recorded(entry.id))[0]?.ropeMethod).toBeNull();
  });

  it.each(["lead", "top_rope", "follow", "unroped"] as const)(
    "accepts direct whole-climb and pitch writes with %s",
    async (ropeMethod) => {
      await write([source()]);
      const entry = await log();
      const rows = await context.db
        .insert(climbingAttempt)
        .values([
          { climbingLogEntryId: entry.id, scope: "climb", ropeMethod },
          { climbingLogEntryId: entry.id, scope: "pitch", ropeMethod },
        ])
        .returning();
      expect(rows.map((attempt) => attempt.ropeMethod)).toEqual([ropeMethod, ropeMethod]);
    },
  );

  it("supports an atomic import that enriches the climb kind and attempt method together", async () => {
    await write([
      source({ climb: { externalId: "route", kind: null }, attempts: [{ scope: "climb" }] }),
    ]);
    await write([source()]);
    expect((await recorded((await log()).id))[0]?.ropeMethod).toBe("lead");
  });
});
