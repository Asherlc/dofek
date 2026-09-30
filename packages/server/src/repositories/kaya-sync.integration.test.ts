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
      id: "4001",
      name: "Test Climbing Gym",
      latitude: "45.12500000",
      longitude: "-90.25000000",
    };
    const climb = {
      id: "2001",
      name: null,
      lead: false,
      climb_type: { id: "1", name: "Bouldering" },
      grade: { id: "6", name: "v4", climb_type_group: "6" },
      gym,
    };
    const attemptedClimbs = [
      { ...climb, id: "1000_2001", attempts: null },
      { ...climb, id: "1000_2002", attempts: null },
      {
        ...climb,
        id: "1000_2003",
        grade: { id: "5", name: "v3", climb_type_group: "5" },
        attempts: null,
      },
    ];
    const ascents = [
      {
        id: "3001",
        session_id: "1000",
        date: started.toISOString(),
        attempts: null,
        ascent_type: { id: "repeat", name: "Repeat" },
        climb,
      },
      {
        id: "3002",
        session_id: "1000",
        date: started.toISOString(),
        attempts: 1,
        ascent_type: { id: "onsight", name: "Onsight" },
        climb: { ...climb, id: "2004", grade: { id: "5", name: "v3", climb_type_group: "5" } },
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
                  id: "1000",
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
    expect(entries.find((entry) => entry.externalId === "3001")).toMatchObject({
      sent: true,
      attemptCount: null,
    });
    expect(entries.find((entry) => entry.externalId === "1000_2001")).toMatchObject({
      sent: false,
      attemptCount: null,
      raw: expect.objectContaining({ id: "1000_2001", attempts: null }),
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

  it.each([
    { failure: "database validation", invalid: { name: "" } },
    { failure: "a missing grade", invalid: { grade: null } },
  ])(
    "preserves the previous session and entries when a replacement fails $failure",
    async ({ invalid }) => {
      const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await context.db
        .delete(activity)
        .where(
          and(
            eq(activity.providerId, "kaya"),
            eq(activity.userId, TEST_USER_ID),
            eq(activity.externalId, "integrity-session"),
          ),
        );
      const [priorActivity] = await context.db
        .insert(activity)
        .values({
          providerId: "kaya",
          userId: TEST_USER_ID,
          externalId: "integrity-session",
          canonicalType: "climbing",
          providerType: "rock_climbing",
          startedAt,
          endedAt: new Date(startedAt.valueOf() + 60 * 60 * 1000),
          localTimeSource: "unknown",
        })
        .returning();
      if (!priorActivity) throw new Error("Failed to seed the previous Kaya session");
      const previousEntries = await context.db
        .insert(climbingEntry)
        .values({
          providerId: "kaya",
          userId: TEST_USER_ID,
          activityId: priorActivity.id,
          externalId: "prior-ascent",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
          sent: true,
          attemptCount: 1,
        })
        .returning();
      const climb = {
        id: "climb",
        name: null,
        lead: false,
        climb_type: { id: "1", name: "Bouldering" },
        grade: { id: "6", name: "v4", climb_type_group: "6" },
        gym: null,
      };
      server.use(
        http.post("https://kaya-beta.kayaclimb.com/graphql", async ({ request }) => {
          const { query } = z.object({ query: z.string() }).parse(await request.json());
          return HttpResponse.json({
            data: query.includes("query sessionsForUser")
              ? {
                  sessionsForUser: [
                    {
                      id: "integrity-session",
                      start_time: startedAt.toISOString(),
                      end_time: new Date(startedAt.valueOf() + 60 * 60 * 1000).toISOString(),
                      gym: null,
                      attempted_climbs: [
                        { ...climb, id: "integrity-session_project", attempts: null, ...invalid },
                      ],
                    },
                  ],
                }
              : {
                  ascentsForUser: [
                    {
                      id: "replacement-ascent",
                      session_id: "integrity-session",
                      date: startedAt.toISOString(),
                      attempts: 1,
                      ascent_type: { id: "repeat", name: "Repeat" },
                      climb,
                    },
                  ],
                },
          });
        }),
      );

      const result = await new KayaSyncProvider().sync(
        new SyncRun({ db: context.db, userId: TEST_USER_ID, window: SyncWindow.full() }),
      );
      expect(result).toMatchObject({
        recordsSynced: 0,
        errors: [expect.objectContaining({ message: expect.any(String) })],
      });
      const retainedActivity = await context.db
        .select()
        .from(activity)
        .where(eq(activity.id, priorActivity.id));
      expect(retainedActivity).toEqual([priorActivity]);
      const retained = await context.db
        .select()
        .from(climbingEntry)
        .where(eq(climbingEntry.activityId, priorActivity.id));
      expect(retained).toEqual(previousEntries);
    },
  );
});
