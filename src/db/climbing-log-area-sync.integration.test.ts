import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import {
  clearClimbingLogSyncTestContext,
  createClimbingLogSyncTestContext,
  CLIMBING_SYNC_OTHER_PROVIDER_ID as otherProviderId,
  CLIMBING_SYNC_OTHER_USER_ID as otherUserId,
  CLIMBING_SYNC_PROVIDER_ID as providerId,
} from "./climbing-log-sync-test-helpers.ts";
import { area, climb, climbingLogEntry } from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { createTestBarrier, hasDatabaseLockWaiter, type TestContext } from "./test-helpers.ts";

describe("climbing log area synchronization", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await createClimbingLogSyncTestContext();
  });
  afterEach(async () => {
    await clearClimbingLogSyncTestContext(context);
  });
  afterAll(async () => {
    await context.cleanup();
  });
  function write(entries: readonly SourceClimbingLogEntry[]) {
    return persistClimbingLogEntries(context.db, { userId: TEST_USER_ID, providerId, entries });
  }
  it("retains verified area identity through an associated path when later responses lack identifiers", async () => {
    await write([
      {
        externalId: "occurrence:missing-ids",
        climb: {
          externalId: "route:retained",
          areas: [
            {
              externalId: "area:retained",
              name: "Known area",
              coordinates: { longitude: -122.25, latitude: 37.5 },
            },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [before] = await context.db.select().from(area);
    await write([
      {
        externalId: "occurrence:missing-ids",
        climb: { externalId: null, areas: [{ externalId: null, name: "Known area" }] },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect(await context.db.select().from(area)).toEqual([before]);
    expect((await context.db.select().from(climb))[0]?.externalId).toBe("route:retained");
  });
  it("removes replaced unreferenced local chains", async () => {
    await write([
      {
        externalId: "occurrence:move",
        climb: {
          externalId: "route:moved",
          areas: [
            { externalId: null, name: "Old region" },
            { externalId: null, name: "Old gym" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    await write([
      {
        externalId: "occurrence:move",
        climb: {
          externalId: "route:moved",
          areas: [
            { externalId: null, name: "New region" },
            { externalId: null, name: "New gym" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect((await context.db.select().from(area)).map((a) => a.name).sort()).toEqual([
      "New gym",
      "New region",
    ]);
    await write([
      {
        externalId: "occurrence:move",
        climb: { externalId: "route:moved", areas: [] },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect(await context.db.select().from(area)).toHaveLength(0);
    expect((await context.db.select().from(climb))[0]?.areaId).toBeNull();
  });
  it("isolates equal source keys and names by owner and provider", async () => {
    const entries: SourceClimbingLogEntry[] = [
      {
        externalId: "occurrence:same",
        attempts: [{ scope: "climb" }],
        climb: {
          externalId: "route:same",
          areas: [{ externalId: "area:same", name: "Same place" }],
        },
      },
    ];
    await write(entries);
    await persistClimbingLogEntries(context.db, { userId: otherUserId, providerId, entries });
    await persistClimbingLogEntries(context.db, {
      userId: TEST_USER_ID,
      providerId: otherProviderId,
      entries,
    });
    expect(await context.db.select().from(climbingLogEntry)).toHaveLength(3);
    expect(await context.db.select().from(climb)).toHaveLength(3);
    expect(await context.db.select().from(area)).toHaveLength(3);
  });
  it("clears a shared area's parent only from explicit source evidence", async () => {
    await write([
      {
        externalId: "occurrence:root-change",
        climb: {
          externalId: "route:root-change",
          areas: [
            { externalId: "area:former-parent", name: "Former parent" },
            { externalId: "area:now-root", name: "Recorded place" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    await write([
      {
        externalId: "occurrence:root-change",
        climb: {
          externalId: "route:root-change",
          areas: [{ externalId: "area:now-root", name: "Recorded place" }],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [preserved] = await context.db
      .select()
      .from(area)
      .where(eq(area.externalId, "area:now-root"));
    expect(preserved?.parentAreaId).not.toBeNull();
    await write([
      {
        externalId: "occurrence:root-change",
        climb: {
          externalId: "route:root-change",
          areas: [{ externalId: "area:now-root", name: "Recorded place", parentExternalId: null }],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [cleared] = await context.db
      .select()
      .from(area)
      .where(eq(area.externalId, "area:now-root"));
    expect(cleared?.parentAreaId).toBeNull();
    expect((await context.db.select().from(area)).map((a) => a.name)).toEqual(["Recorded place"]);
  });
  it("serializes opposite reparentings to reject a concurrent cycle", async () => {
    await write([
      {
        externalId: "occurrence:a",
        climb: { externalId: "route:a", areas: [{ externalId: "area:a", name: "A" }] },
        attempts: [{ scope: "climb" as const }],
      },
      {
        externalId: "occurrence:b",
        climb: { externalId: "route:b", areas: [{ externalId: "area:b", name: "B" }] },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const locked = createTestBarrier();
    const release = createTestBarrier();
    const first = context.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`climbing-graph:${TEST_USER_ID}:${providerId}`}, 0))`,
      );
      locked.resolve();
      await release.promise;
      return persistClimbingLogEntries(tx, {
        userId: TEST_USER_ID,
        providerId,
        entries: [
          {
            externalId: "occurrence:a",
            climb: {
              externalId: "route:a",
              areas: [
                { externalId: "area:b", name: "B" },
                { externalId: "area:a", name: "A" },
              ],
            },
            attempts: [{ scope: "climb" as const }],
          },
        ],
      });
    });
    await locked.promise;
    const second = write([
      {
        externalId: "occurrence:b",
        climb: {
          externalId: "route:b",
          areas: [
            { externalId: "area:a", name: "A" },
            { externalId: "area:b", name: "B" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const settled = Promise.allSettled([first, second]);
    try {
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
    } finally {
      release.resolve();
    }
    const result = await settled;
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const [a] = await context.db
      .select()
      .from(area)
      .where(and(eq(area.providerId, providerId), eq(area.externalId, "area:a")));
    const [b] = await context.db
      .select()
      .from(area)
      .where(and(eq(area.providerId, providerId), eq(area.externalId, "area:b")));
    expect(a?.parentAreaId).toBe(b?.id);
    expect(b?.parentAreaId).toBeNull();
  });
});
