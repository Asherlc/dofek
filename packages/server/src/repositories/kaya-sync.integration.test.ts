import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity, climbingEntry } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../../../src/db/tokens.ts";
import { KayaSyncProvider } from "../../../../src/providers/kaya-sync.ts";
import { SyncRun } from "../../../../src/providers/sync-run.ts";
import { SyncWindow } from "../../../../src/providers/sync-window.ts";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { ClimbingRepository } from "./climbing-repository.ts";

const server = setupServer();

describe("Kaya attempted-climb import (PostgreSQL integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(
      context.db,
      "kaya",
      "Kaya",
      "https://kaya-beta.kayaclimb.com",
      TEST_USER_ID,
    );
    await saveTokens(
      context.db,
      "kaya",
      {
        accessToken: "kaya-test-token",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00.000Z"),
        scopes: JSON.stringify({ kayaUserId: "42" }),
      },
      TEST_USER_ID,
    );
  }, 60_000);

  afterAll(async () => {
    server.close();
    await context?.cleanup();
  });

  it("re-syncs both feeds idempotently and serves unknown counts without losing sends", async () => {
    const started = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const gym = {
      id: "413",
      name: "Touchstone Pacific Pipe",
      latitude: "37.81535500",
      longitude: "-122.28925760",
    };
    const climb = {
      id: "2156989",
      name: null,
      lead: false,
      climb_type: { id: "1", name: "Bouldering" },
      grade: { id: "6", name: "v4", climb_type_group: "6" },
      gym,
    };
    const attemptedClimbs = [
      { ...climb, id: "3077580_2156989", attempts: null },
      { ...climb, id: "3077580_2156990", attempts: null },
      {
        ...climb,
        id: "3077580_2173959",
        grade: { id: "5", name: "v3", climb_type_group: "5" },
        attempts: null,
      },
    ];
    const ascents = [
      {
        id: "13633488",
        session_id: "3077580",
        date: started.toISOString(),
        attempts: null,
        ascent_type: { id: "repeat", name: "Repeat" },
        climb,
      },
      {
        id: "13633550",
        session_id: "3077580",
        date: started.toISOString(),
        attempts: 1,
        ascent_type: { id: "onsight", name: "Onsight" },
        climb: { ...climb, id: "2173944", grade: { id: "5", name: "v3", climb_type_group: "5" } },
      },
    ];
    server.use(
      http.post("https://kaya-beta.kayaclimb.com/graphql", async ({ request }) => {
        const { query } = z.object({ query: z.string() }).parse(await request.json());
        if (query.includes("query sessionsForUser")) {
          return HttpResponse.json({
            data: {
              sessionsForUser: [
                {
                  id: "3077580",
                  start_time: started.toISOString(),
                  end_time: new Date(started.valueOf() + 60 * 60 * 1000).toISOString(),
                  gym,
                  ...(query.includes("attempted_climbs")
                    ? { attempted_climbs: attemptedClimbs }
                    : {}),
                },
              ],
            },
          });
        }
        return HttpResponse.json({ data: { ascentsForUser: ascents } });
      }),
    );
    const provider = new KayaSyncProvider();
    const sync = () =>
      provider.sync(
        new SyncRun({ db: context.db, userId: TEST_USER_ID, window: SyncWindow.full() }),
      );
    await expect(sync()).resolves.toMatchObject({ recordsSynced: 5, errors: [] });
    await expect(sync()).resolves.toMatchObject({ recordsSynced: 5, errors: [] });

    const entries = await context.db
      .select()
      .from(climbingEntry)
      .where(and(eq(climbingEntry.userId, TEST_USER_ID), eq(climbingEntry.providerId, "kaya")));
    expect(entries).toHaveLength(5);
    expect(entries.filter((entry) => entry.sent)).toHaveLength(2);
    expect(entries.filter((entry) => entry.sent === false)).toHaveLength(3);
    expect(entries.find((entry) => entry.externalId === "13633488")).toMatchObject({
      sent: true,
      attemptCount: null,
    });
    expect(entries.find((entry) => entry.externalId === "3077580_2156989")).toMatchObject({
      sent: false,
      attemptCount: null,
      raw: expect.objectContaining({ id: "3077580_2156989", attempts: null }),
    });
    const [session] = await context.db
      .select()
      .from(activity)
      .where(and(eq(activity.userId, TEST_USER_ID), eq(activity.providerId, "kaya")));
    if (!session?.groupId) throw new Error("Kaya activity was not persisted");
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    const details = (await repository.getActivityEntries(session.groupId)).map((entry) =>
      entry.toDetail(),
    );
    expect(details).toHaveLength(5);
    expect(details.filter((entry) => entry.sent === false)).toEqual([
      expect.objectContaining({ attemptCount: null, attempts: [], grade: "V4" }),
      expect.objectContaining({ attemptCount: null, attempts: [], grade: "V4" }),
      expect.objectContaining({ attemptCount: null, attempts: [], grade: "V3" }),
    ]);
    expect((await repository.getSessionSummaries(30)).map((entry) => entry.toDetail())).toEqual([
      expect.objectContaining({ activityId: session.groupId, attempts: null, sends: 2 }),
    ]);
    expect((await repository.getVolumeByGrade(30)).map((entry) => entry.toDetail())).toEqual([
      expect.objectContaining({ grade: "V3", attempts: null, sends: 1 }),
      expect.objectContaining({ grade: "V4", attempts: null, sends: 1 }),
    ]);
  });
});
