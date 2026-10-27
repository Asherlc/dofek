import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "../../../../src/db/schema/activity.ts";
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

  it("re-syncs both feeds idempotently and serves recorded attempts without losing source occurrences", async () => {
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
      destination: null,
      area: null,
      subarea: null,
      board: { id: "board-1", name: "Training Board" },
      angle: 0,
      climb_type: { id: "1", name: "Bouldering" },
      grade: { id: "6", name: "v4", climb_type_group: "6" },
      gym,
    };
    const attemptedClimbs = [
      { ...climb, id: "1000_2001", sent: false, attempts: null },
      { ...climb, id: "1000_2002", sent: false, attempts: null },
      {
        ...climb,
        id: "1000_2003",
        sent: false,
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

    const [session] = await context.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "kaya"));
    if (!session?.groupId) throw new Error("Expected KAYA activity group");
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    const details = (await repository.getActivityLogEntries(session.groupId)).map((row) =>
      row.toDetail(),
    );
    expect(details).toHaveLength(5);
    expect(details.find((row) => row.externalId === "kaya:ascent:3001")).toMatchObject({
      recordedClimbAttemptCount: 1,
      recordedClimbOutcome: "completed",
      board: { name: "Training Board", externalId: "board-1" },
      wallAngle: { value: 0, unit: null },
      attempts: [expect.objectContaining({ hadCompletedBefore: true })],
    });
    expect(details.filter((row) => row.externalId?.includes(":attempted:"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordedClimbAttemptCount: 1,
          recordedClimbOutcome: "failed",
          attempts: [expect.objectContaining({ outcome: "failed" })],
        }),
      ]),
    );
    expect(details.filter((row) => row.externalId?.includes(":attempted:"))).toHaveLength(3);
    expect((await repository.getVolumeByGrade(30)).map((row) => row.toDetail())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grade: "V3", recordedAttempts: 2, sends: 1 }),
        expect.objectContaining({ grade: "V4", recordedAttempts: 3, sends: 1 }),
      ]),
    );
    expect((await repository.getSessionSummaries(30))[0]?.toDetail()).toMatchObject({
      attempts: 5,
      sends: 2,
      hardestBoulderGrade: "V4",
    });
  });
});
