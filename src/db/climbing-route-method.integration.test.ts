import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import type { TransactionDatabase } from "./index.ts";
import { climb, climbingAttempt, climbingLogEntry } from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { MissingRouteMethodError } from "./source-attempt-facts.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "./test-helpers.ts";

const providerId = "route-method-test";

describe("required climbing route methods", () => {
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

  it("rolls back the entire import when a route attempt has no method", async () => {
    await expect(
      write([
        source({ externalId: "valid-first" }),
        source({ externalId: "missing-method", attempts: [{ scope: "climb" }] }),
      ]),
    ).rejects.toThrow(MissingRouteMethodError);
    expect(await context.db.select().from(climbingLogEntry)).toHaveLength(0);
    expect(await context.db.select().from(climb)).toHaveLength(0);
  });

  it("requires method evidence for counted route attempts instead of copying one try's facts", async () => {
    await expect(
      write([source({ reportedAttemptCounts: [{ scope: "climb", count: 3 }] })]),
    ).rejects.toThrow(MissingRouteMethodError);
    expect(await context.db.select().from(climbingLogEntry)).toHaveLength(0);
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

  it("keeps bouldering counts exempt", async () => {
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

  it("retains known methods on partial refreshes and rejects explicitly clearing them", async () => {
    await write([source()]);
    const entry = await log();
    await write([{ externalId: "route-log", attempts: [{ scope: "climb", notes: "Updated" }] }]);
    expect(await recorded(entry.id)).toEqual([
      expect.objectContaining({ ropeMethod: "lead", notes: "Updated" }),
    ]);
    await expect(
      write([{ externalId: "route-log", attempts: [{ scope: "climb", ropeMethod: null }] }]),
    ).rejects.toThrow(MissingRouteMethodError);
    expect((await recorded(entry.id))[0]?.ropeMethod).toBe("lead");
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

  it("rejects direct inserts and updates that leave a route method empty", async () => {
    await write([source()]);
    const entry = await log();
    for (const scope of ["climb", "pitch"] as const) {
      await expect(
        context.db.insert(climbingAttempt).values({ climbingLogEntryId: entry.id, scope }),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint: "climbing_attempt_route_method_required" },
      });
    }
    await expect(
      context.db
        .update(climbingAttempt)
        .set({ ropeMethod: null })
        .where(eq(climbingAttempt.climbingLogEntryId, entry.id)),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "climbing_attempt_route_method_required" },
    });
  });

  it("checks a methodless route attempt even if its ID changes before commit", async () => {
    await write([source()]);
    const entry = await log();
    await expect(
      context.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(climbingAttempt)
          .values({ climbingLogEntryId: entry.id, scope: "climb" })
          .returning();
        if (!created) throw new Error("Expected a pending test attempt.");
        await tx
          .update(climbingAttempt)
          .set({ id: randomUUID() })
          .where(eq(climbingAttempt.id, created.id));
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "climbing_attempt_route_method_required" },
    });
  });

  it("checks method requirements when attempts, logs, or climb kinds change", async () => {
    await write([
      source(),
      source({
        externalId: "boulder-log",
        climb: { externalId: "boulder", kind: "boulder" },
        attempts: [{ scope: "climb" }],
      }),
    ]);
    const route = await log();
    const boulder = await log("boulder-log");
    await expect(
      context.db
        .update(climbingAttempt)
        .set({ climbingLogEntryId: route.id })
        .where(eq(climbingAttempt.climbingLogEntryId, boulder.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      context.db
        .update(climbingLogEntry)
        .set({ climbId: route.climbId })
        .where(eq(climbingLogEntry.id, boulder.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      context.db.update(climb).set({ kind: "route" }).where(eq(climb.id, boulder.climbId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await context.db.transaction(async (tx) => {
      await tx.update(climb).set({ kind: "route" }).where(eq(climb.id, boulder.climbId));
      await tx
        .update(climbingAttempt)
        .set({ ropeMethod: "follow" })
        .where(eq(climbingAttempt.climbingLogEntryId, boulder.id));
    });
    expect((await recorded(boulder.id))[0]?.ropeMethod).toBe("follow");
  });

  it("supports an atomic import that enriches the climb kind and attempt method together", async () => {
    await write([
      source({ climb: { externalId: "route", kind: null }, attempts: [{ scope: "climb" }] }),
    ]);
    await write([source()]);
    expect((await recorded((await log()).id))[0]?.ropeMethod).toBe("lead");
  });

  it.each(["climb-kind", "log-target"] as const)(
    "serializes %s changes against concurrent methodless writes",
    async (change) => {
      await write([
        source({ climb: { externalId: "unknown", kind: null } }),
        source({ externalId: "target-log", climb: { externalId: "target", kind: "route" } }),
      ]);
      const entry = await log();
      const target = await log("target-log");
      for (const firstAction of ["attempt", "change"] as const) {
        const locked = createTestBarrier();
        const release = createTestBarrier();
        const act = async (tx: TransactionDatabase, action: typeof firstAction) => {
          if (action === "attempt")
            return tx
              .insert(climbingAttempt)
              .values({ climbingLogEntryId: entry.id, scope: "climb" });
          if (change === "climb-kind")
            return tx.update(climb).set({ kind: "route" }).where(eq(climb.id, entry.climbId));
          return tx
            .update(climbingLogEntry)
            .set({ climbId: target.climbId })
            .where(eq(climbingLogEntry.id, entry.id));
        };
        const first = context.db.transaction(async (tx) => {
          await act(tx, firstAction);
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const second = context.db.transaction((tx) =>
          act(tx, firstAction === "attempt" ? "change" : "attempt"),
        );
        const settled = Promise.allSettled([first, second]);
        try {
          await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
        } finally {
          release.resolve();
        }
        expect((await settled).map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
        // Reset only the isolated fixture before testing the opposite lock order.
        await context.db
          .delete(climbingAttempt)
          .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
        await context.db.update(climb).set({ kind: null }).where(eq(climb.id, entry.climbId));
        await context.db
          .update(climbingLogEntry)
          .set({ climbId: entry.climbId })
          .where(eq(climbingLogEntry.id, entry.id));
        await context.db
          .insert(climbingAttempt)
          .values({ climbingLogEntryId: entry.id, scope: "climb", ropeMethod: "lead" });
      }
    },
  );
});
