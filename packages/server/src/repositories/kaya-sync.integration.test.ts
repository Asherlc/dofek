import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climbingLogEntry, climb as climbTable } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../../../src/db/tokens.ts";
import { KayaSyncProvider } from "../../../../src/providers/kaya-sync.ts";
import { SyncRun } from "../../../../src/providers/sync-run.ts";
import { SyncWindow } from "../../../../src/providers/sync-window.ts";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { buildClimbingStrengths } from "../services/climbing-strengths.ts";
import { seedClimbingActivity, seedClimbingLog } from "./climbing-integration-test-helpers.ts";
import { ClimbingLogEntryAssociator } from "./climbing-log-entry-associator.ts";
import { ClimbingRepository } from "./climbing-repository.ts";
import { ClimbingStrengthsRepository } from "./climbing-strengths-repository.ts";

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

  afterEach(async () => {
    server.resetHandlers();
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climbTable);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity);
  });

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
      tags: [],
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
        grade: null,
        ascent_type: { id: "repeat", name: "Repeat" },
        climb,
      },
      {
        id: "3002",
        session_id: "1000",
        date: started.toISOString(),
        attempts: 1,
        grade: null,
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

  it("refreshes retained KAYA metadata without replacing identities or user attachments", async () => {
    const started = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const day = started.toISOString().slice(0, 10);
    await ensureProvider(context.db, "test-climbing", "Test Climbing", undefined, TEST_USER_ID);
    const attachment = await seedClimbingActivity(
      context.db,
      "test-climbing",
      "metadata-attachment",
      started,
    );
    const entryId = await seedClimbingLog(context.db, "kaya", {
      externalId: "kaya:ascent:3101",
      climbedOn: day,
      discipline: "rock_climbing",
      sourceName: "Kaya",
      wallAngle: { value: -20, unit: null },
      holdTypes: null,
      climb: {
        externalId: "2101",
        name: "Metadata boulder",
        kind: "boulder",
        setting: "outdoor",
        publishedGrades: [{ value: "v4", system: "v_scale" }],
      },
      attempts: [{ scope: "climb", sourceResult: "Send", qualifier: "free-send" }],
      raw: { id: "3101", climb: { id: "2101", angle: -20 } },
    });
    await new ClimbingLogEntryAssociator(context.db, TEST_USER_ID, "UTC").attachLogEntry({
      climbingLogEntryId: entryId,
      activityId: attachment.groupId,
    });
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "UTC");
    const [legacy] = (await repository.getActivityLogEntries(attachment.groupId)).map((entry) =>
      entry.toDetail(),
    );
    expect(legacy).toMatchObject({
      id: entryId,
      activityId: attachment.id,
      holdTypes: null,
      wallAngle: { value: -20, unit: null },
      attempts: [expect.objectContaining({ outcome: "completed" })],
    });
    if (!legacy) throw new Error("Expected retained KAYA log");

    const tags = [
      { id: "937", name: "Crimp", color: null, icon: null, tag_type_id: "3" },
      { id: "939", name: "Jug", color: "#ffffff", icon: "jug", tag_type_id: "3" },
      { id: "777", name: "Balance", color: null, icon: null, tag_type_id: "1" },
    ];
    const source = {
      id: "3101",
      session_id: null,
      date: started.toISOString(),
      attempts: 1,
      grade: { id: "5", name: "v3", climb_type_group: "5" },
      ascent_type: { id: "send", name: "Send" },
      comment: "Kept the original log.",
      photo: { photo_url: "https://cdn.test/climb.jpg", thumb_url: "https://cdn.test/thumb.jpg" },
      video: { video_url: "https://cdn.test/climb.mp4", thumb_url: "https://cdn.test/video.jpg" },
      climb: {
        id: "2101",
        name: "Metadata boulder",
        lead: null,
        gym: null,
        destination: { id: "outdoor-1", name: "Outdoor crag", latitude: 37, longitude: -122 },
        area: null,
        subarea: null,
        wallarea: null,
        board: null,
        angle: -20,
        tags,
        latitude: "0",
        longitude: "0",
        description: "An explicitly tagged slab.",
        climb_type: { id: "1", name: "Bouldering" },
        grade: { id: "6", name: "v4", climb_type_group: "6" },
      },
    };
    server.use(
      http.post("https://kaya-beta.kayaclimb.com/graphql", async ({ request }) => {
        const { query } = z.object({ query: z.string() }).parse(await request.json());
        return HttpResponse.json({
          data: query.includes("query sessionsForUser")
            ? { sessionsForUser: [] }
            : { ascentsForUser: [source] },
        });
      }),
    );
    const provider = new KayaSyncProvider();
    const sync = () =>
      provider.sync(
        new SyncRun({ db: context.db, userId: TEST_USER_ID, window: SyncWindow.full() }),
      );
    await expect(sync()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    await expect(sync()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });

    const details = (await repository.getActivityLogEntries(attachment.groupId)).map((entry) =>
      entry.toDetail(),
    );
    expect(details).toHaveLength(1);
    const refreshed = details[0];
    expect(refreshed).toMatchObject({
      id: legacy.id,
      climbId: legacy.climbId,
      activityId: attachment.id,
      holdTypes: ["crimp", "jug"],
      wallAngle: { category: "slab" },
      reportedGrades: [{ value: "v3", system: "v_scale" }],
      displayGrade: "V4",
      climb: {
        publishedGrades: [{ value: "v4", system: "v_scale" }],
        coordinates: { latitude: 0, longitude: 0 },
        areaPath: [expect.objectContaining({ name: "Outdoor crag" })],
      },
      mapLocation: { scope: "climb", coordinates: { latitude: 0, longitude: 0 } },
      raw: {
        grade: source.grade,
        video: source.video,
        climb: { tags, angle: -20, description: source.climb.description },
      },
    });
    const [stored] = await context.db
      .select({ raw: climbingLogEntry.raw })
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, entryId));
    expect(stored?.raw).toMatchObject({ photo: source.photo, video: source.video });
    expect(refreshed?.attempts.map((attempt) => attempt.id)).toEqual(
      legacy.attempts.map((attempt) => attempt.id),
    );
    const strengths = buildClimbingStrengths(
      await new ClimbingStrengthsRepository(context.db, TEST_USER_ID, "UTC").getObservations(
        30,
        {},
        day,
      ),
      { startDate: day, endDate: day },
    );
    const holds = strengths.panels.find((panel) => panel.dimension === "hold_type");
    expect(holds?.grades).toMatchObject([{ grade: "V4", climbs: 1, sends: 1 }]);
    expect(holds?.allGrades.grades).toMatchObject([{ climbs: 1, sends: 1 }]);
    expect(holds?.rows.map((row) => ({ key: row.key, climbs: row.cells[0]?.climbs }))).toEqual([
      { key: "crimp", climbs: 1 },
      { key: "jug", climbs: 1 },
    ]);
    const angles = strengths.panels.find((panel) => panel.dimension === "wall_angle");
    expect(angles?.rows).toMatchObject([
      { key: "slab", label: "Slab", cells: [{ grade: "V4", climbs: 1, sends: 1 }] },
    ]);
  });
});
