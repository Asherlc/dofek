import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "../db/schema/activity.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
} from "../db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { KayaSyncProvider } from "./kaya-sync.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { kayaAscentFixture, kayaClimbFixture, kayaSessionFixture } from "./test-helpers.ts";

const server = setupServer();
describe("KayaSyncProvider canonical persistence", () => {
  let context: TestContext;
  let sessions: Record<string, unknown>[];
  let ascents: Record<string, unknown>[];
  beforeAll(async () => {
    context = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(context.db, "kaya", "Kaya", "https://kaya-beta.kayaclimb.com", userId);
    await saveTokens(
      context.db,
      "kaya",
      {
        accessToken: "test-token",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        scopes: JSON.stringify({ kayaUserId: "42" }),
      },
      userId,
    );
  });
  beforeEach(() => {
    sessions = [
      kayaSessionFixture({
        attempted_climbs: [{ ...kayaClimbFixture(), id: "1000_2001", attempts: 4 }],
      }),
    ];
    ascents = [kayaAscentFixture()];
    server.use(
      http.post("https://kaya-beta.kayaclimb.com/graphql", async ({ request }) => {
        const { query } = z.object({ query: z.string() }).parse(await request.json());
        return HttpResponse.json({
          data: query.includes("query sessionsForUser")
            ? { sessionsForUser: sessions }
            : { ascentsForUser: ascents },
        });
      }),
    );
  });
  afterEach(async () => {
    server.resetHandlers();
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity).where(eq(activity.providerId, "kaya"));
  });
  afterAll(async () => {
    server.close();
    await context.cleanup();
  });
  function run(window = SyncWindow.full(new Date("2026-08-02T00:00:00Z"))) {
    return new KayaSyncProvider().sync(
      new SyncRun({
        db: context.db,
        userId,
        window,
      }),
    );
  }
  const logs = () =>
    context.db.select().from(climbingLogEntry).orderBy(climbingLogEntry.externalId);

  it("persists recorded colors from both feeds while keeping unnamed climbs unnamed", async () => {
    const coloredClimb = kayaClimbFixture({ name: null, color: { name: "Blue" } });
    sessions = [
      kayaSessionFixture({ attempted_climbs: [{ ...coloredClimb, id: "1000_2001", attempts: 1 }] }),
    ];
    ascents = [kayaAscentFixture({ climb: coloredClimb })];
    expect(await run()).toMatchObject({ errors: [] });
    const retained = await logs();
    expect(retained).toHaveLength(2);
    expect(retained.map((entry) => entry.raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ climb: expect.objectContaining({ color: { name: "Blue" } }) }),
        expect.objectContaining({ color: { name: "Blue" } }),
      ]),
    );
    expect((await context.db.select().from(climb)).every((row) => row.name === null)).toBe(true);
  });
  it("retires standalone ascents when the complete logbook becomes empty", async () => {
    sessions = [];
    ascents = [kayaAscentFixture({ session_id: null })];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await logs();
    const attempts = await context.db.select().from(climbingAttempt);

    ascents = [];
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await logs()).toEqual(
      before.map((entry) => ({ ...entry, providerAbsentAt: expect.any(Date) })),
    );
    expect(await context.db.select().from(climbingAttempt)).toEqual(attempts);

    ascents = [kayaAscentFixture({ session_id: null })];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toEqual(before);
  });

  it("reconciles missing ticks in historical sessions during scheduled syncs", async () => {
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    ascents = [];
    const window = SyncWindow.lastDays(7, { now: new Date("2026-10-11T00:00:00Z") });
    expect(await run(window)).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toEqual([
      expect.objectContaining({
        externalId: "kaya:ascent:3001",
        providerAbsentAt: expect.any(Date),
      }),
      expect.objectContaining({
        externalId: "kaya:session:1000:attempted:1000_2001",
        providerAbsentAt: null,
      }),
    ]);
  });

  it("retires ticks from sessions removed from the provider", async () => {
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await logs();
    sessions = [];
    ascents = [];
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await logs()).toEqual(
      before.map((entry) => ({ ...entry, providerAbsentAt: expect.any(Date) })),
    );
    expect(await context.db.select().from(activity)).toEqual([
      expect.objectContaining({ externalId: "1000", providerAbsentAt: expect.any(Date) }),
    ]);

    sessions = [
      kayaSessionFixture({
        attempted_climbs: [{ ...kayaClimbFixture(), id: "1000_2001", attempts: 4 }],
      }),
    ];
    ascents = [kayaAscentFixture()];
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await logs()).toEqual(before);
    expect(await context.db.select().from(activity)).toEqual([
      expect.objectContaining({ externalId: "1000", providerAbsentAt: null }),
    ]);
  });

  it("preserves saved ticks when a GraphQL response omits the requested list", async () => {
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await logs();
    server.use(http.post("https://kaya-beta.kayaclimb.com/graphql", () => HttpResponse.json({})));
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await logs()).toEqual(before);
  });

  it("preserves saved ticks when a session has an invalid start time", async () => {
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await logs();
    sessions = [kayaSessionFixture({ start_time: "invalid" })];
    expect(await run()).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await logs()).toEqual(before);
  });

  it("keeps a surviving ascent active when its provider session is removed", async () => {
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const original = (await logs()).find((entry) => entry.externalId === "kaya:ascent:3001");
    sessions = [];
    ascents = [kayaAscentFixture({ session_id: null })];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect((await logs()).find((entry) => entry.externalId === "kaya:ascent:3001")).toMatchObject({
      id: original?.id,
      activityId: null,
      providerAbsentAt: null,
    });
  });

  it("preserves a user-selected outing when the ascent's original source session disappears", async () => {
    const selectedSession = kayaSessionFixture({ id: "user-picked", attempted_climbs: [] });
    sessions.push(selectedSession);
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const [selectedActivity] = await context.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "user-picked"));
    if (!selectedActivity) throw new Error("Expected the selected outing");
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: selectedActivity.id })
      .where(eq(climbingLogEntry.externalId, "kaya:ascent:3001"));
    const selectedEntry = (await logs()).find((entry) => entry.externalId === "kaya:ascent:3001");
    sessions = [selectedSession];
    ascents = [kayaAscentFixture({ session_id: null })];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect((await logs()).find((entry) => entry.externalId === "kaya:ascent:3001")).toMatchObject({
      id: selectedEntry?.id,
      activityId: selectedActivity.id,
      providerAbsentAt: null,
    });
  });
  it("preserves separate source occurrences on one climb and expands only the reported count", async () => {
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await logs();
    expect(before).toHaveLength(2);
    expect(new Set(before.map((log) => log.climbId)).size).toBe(1);
    expect(await context.db.select().from(climb)).toEqual([
      expect.objectContaining({ externalId: "2001", setting: "indoor", coordinates: null }),
    ]);
    expect(await context.db.select().from(area)).toEqual([
      expect.objectContaining({ externalId: "4001", coordinates: { x: -122.25, y: 0 } }),
    ]);
    expect(await context.db.select().from(climbGrade)).toEqual([
      expect.objectContaining({ value: "V4", system: "v_scale" }),
    ]);
    const attempts = await context.db.select().from(climbingAttempt);
    expect(attempts).toHaveLength(5);
    const send = before.find((log) => log.externalId === "kaya:ascent:3001");
    if (!send) throw new Error("Expected source ascent");
    expect(attempts.filter((attempt) => attempt.climbingLogEntryId === send.id)).toEqual([
      expect.objectContaining({
        scope: "climb",
        sourceResult: "Flash",
        fellOrHung: false,
        dabbed: false,
        usedAid: false,
        receivedBeta: null,
        attemptIndex: 1,
      }),
    ]);
    expect(
      attempts
        .filter((attempt) => attempt.climbingLogEntryId !== send.id)
        .every((attempt) => attempt.sourceResult === null && attempt.attemptIndex === null),
    ).toBe(true);
    expect(await run()).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await logs()).toEqual(before);
    expect(
      (await context.db.select().from(climbingAttempt)).map((attempt) => attempt.id).sort(),
    ).toEqual(attempts.map((attempt) => attempt.id).sort());
  });
  it("retains one exact source result while refreshing the same ascent's reported count", async () => {
    sessions = [];
    ascents = [
      kayaAscentFixture({
        session_id: null,
        attempts: 3,
        ascent_type: { id: "redpoint", name: " rEdPoInT " },
      }),
    ];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await context.db.select().from(climbingAttempt);
    const described = before.find((attempt) => attempt.sourceResult === " rEdPoInT ");
    if (!described) throw new Error("Expected original source result");
    expect(before).toHaveLength(3);
    expect(before.filter((attempt) => attempt.sourceResult === null)).toHaveLength(2);

    ascents = [
      kayaAscentFixture({
        session_id: null,
        attempts: 4,
        ascent_type: { id: "redpoint", name: " rEdPoInT " },
      }),
    ];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const after = await context.db.select().from(climbingAttempt);
    expect(after).toHaveLength(4);
    expect(after.filter((attempt) => attempt.sourceResult !== null)).toEqual([
      expect.objectContaining({ id: described.id, sourceResult: " rEdPoInT " }),
    ]);
    expect(after.filter((attempt) => attempt.sourceResult === null)).toHaveLength(3);
  });
  it("retains a nullable standalone source occurrence and later attaches the same ID", async () => {
    sessions = [];
    ascents = [
      kayaAscentFixture({
        session_id: null,
        climb: kayaClimbFixture({ grade: null, lead: null, gym: null }),
      }),
    ];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    const [standalone] = await logs();
    expect(standalone).toMatchObject({
      externalId: "kaya:ascent:3001",
      activityId: null,
      climbedOn: "2026-08-01",
    });
    expect(await context.db.select().from(activity).where(eq(activity.providerId, "kaya"))).toEqual(
      [],
    );
    sessions = [kayaSessionFixture()];
    ascents = [kayaAscentFixture()];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toEqual([
      expect.objectContaining({
        id: standalone?.id,
        activityId: expect.any(String),
        climbedOn: "2026-08-01",
      }),
    ]);
  });
  it("retires missing session occurrences only after complete discovery", async () => {
    await run();
    const before = await logs();
    ascents = [];
    expect(await run()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      (await logs()).find((log) => log.externalId === "kaya:ascent:3001")?.providerAbsentAt,
    ).toBeInstanceOf(Date);
    ascents = [kayaAscentFixture()];
    await run();
    expect((await logs()).every((log) => log.providerAbsentAt === null)).toBe(true);
    server.use(
      http.post(
        "https://kaya-beta.kayaclimb.com/graphql",
        () => new HttpResponse("unavailable", { status: 503 }),
      ),
    );
    expect((await run()).errors).toHaveLength(1);
    expect(await logs()).toEqual(before);
  });
  it("rolls back the activity and graph when an attempted identity is ambiguous", async () => {
    sessions = [
      kayaSessionFixture({
        attempted_climbs: [{ ...kayaClimbFixture(), id: "other_2001", attempts: 2 }],
      }),
    ];
    expect(await run()).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringContaining("climb identity") })],
    });
    expect(await logs()).toEqual([]);
    expect(await context.db.select().from(activity).where(eq(activity.providerId, "kaya"))).toEqual(
      [],
    );
  });
});
