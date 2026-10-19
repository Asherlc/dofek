import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogSnapshot } from "./climbing-log-snapshot.ts";
import type { SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import { climbingAttempt, climbingLogEntry } from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const providerId = "climbing-snapshot-test";
const otherProviderId = "climbing-snapshot-other";
const otherUserId = "00000000-0000-0000-0000-000000000003";

describe("complete climbing log snapshots", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name) VALUES
        (${providerId}, 'Snapshot test'), (${otherProviderId}, 'Other snapshot test')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES (${otherUserId}::uuid, 'Other climber')
    `);
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
  });
  afterAll(async () => {
    await context.cleanup();
  });
  function write(entries: readonly SourceClimbingLogEntry[]) {
    return persistClimbingLogSnapshot(context.db, { userId: TEST_USER_ID, providerId, entries });
  }
  function rows() {
    return context.db.select().from(climbingLogEntry).orderBy(climbingLogEntry.id);
  }
  const first: SourceClimbingLogEntry = {
    externalId: "first",
    raw: { note: "Retained source payload" },
    attempts: [{ scope: "climb", notes: "Retained attempt" }],
  };
  const second: SourceClimbingLogEntry = { externalId: "second", attempts: [{ scope: "climb" }] };

  it("reconciles populated and empty lists without retiring another user, provider, or local record", async () => {
    await write([first, second]);
    await persistClimbingLogSnapshot(context.db, {
      userId: otherUserId,
      providerId,
      entries: [first],
    });
    await persistClimbingLogSnapshot(context.db, {
      userId: TEST_USER_ID,
      providerId: otherProviderId,
      entries: [first],
    });
    await context.db.insert(climbingLogEntry).values({ userId: TEST_USER_ID, providerId });
    const before = await rows();
    const attempts = await context.db.select().from(climbingAttempt).orderBy(climbingAttempt.id);

    await write([second]);
    const removed = (await rows()).find(
      (entry) =>
        entry.userId === TEST_USER_ID &&
        entry.providerId === providerId &&
        entry.externalId === "first",
    );
    expect(removed?.providerAbsentAt).toBeInstanceOf(Date);
    expect(await rows()).toEqual(
      before.map((entry) =>
        entry.id === removed?.id ? { ...entry, providerAbsentAt: removed.providerAbsentAt } : entry,
      ),
    );

    await write([]);
    const absent = await rows();
    expect(absent).toEqual(
      before.map((entry) => {
        if (entry.id === removed?.id) return removed;
        if (
          entry.userId === TEST_USER_ID &&
          entry.providerId === providerId &&
          entry.externalId === "second"
        )
          return { ...entry, providerAbsentAt: expect.any(Date) };
        return entry;
      }),
    );
    await write([]);
    expect(await rows()).toEqual(absent);
    expect(await context.db.select().from(climbingAttempt).orderBy(climbingAttempt.id)).toEqual(
      attempts,
    );

    await write([first, second]);
    expect(await rows()).toEqual(before);
    expect(await context.db.select().from(climbingAttempt).orderBy(climbingAttempt.id)).toEqual(
      attempts,
    );
  });

  it("rolls back new log entries and attempts if absence reconciliation fails", async () => {
    await write([first]);
    const before = await rows();
    const attempts = await context.db.select().from(climbingAttempt);
    await context.db.execute(sql`
      ALTER TABLE fitness.climbing_log_entry ADD CONSTRAINT reject_snapshot_absence
      CHECK (provider_absent_at IS NULL)
    `);
    try {
      await expect(write([second])).rejects.toThrow();
      expect(await rows()).toEqual(before);
      expect(await context.db.select().from(climbingAttempt)).toEqual(attempts);
    } finally {
      await context.db.execute(sql`
        ALTER TABLE fitness.climbing_log_entry DROP CONSTRAINT reject_snapshot_absence
      `);
    }
  });
});
