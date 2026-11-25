import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type PlannedWorkoutEvent,
  replacePlannedWorkoutSnapshot,
} from "../../../../src/db/planned-workout-repository.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import { PlannedWorkoutRepository } from "./planned-workout-repository.ts";

const USER = "00000000-0000-4000-8000-0000000000e1";
const OTHER = "00000000-0000-4000-8000-0000000000e2";
const PROVIDER = "intervals.icu";
const doc = {
  steps: [
    {
      text: "Ramp",
      duration: 600,
      distance: 4000,
      power: { start: 35, end: 55, units: "%ftp" },
      hr: { value: 150, units: "bpm" },
      pace: { start: 5.2, end: 4.8, units: "min/km" },
      cadence: { value: 90, units: "rpm" },
    },
    {
      reps: 4,
      steps: [
        { duration: 300, power: { value: 105, units: "%ftp" } },
        { duration: 180, power: { value: 150, units: "w" } },
      ],
    },
  ],
};

const event = (
  id: number,
  startDate: string,
  extra: Partial<PlannedWorkoutEvent> = {},
): PlannedWorkoutEvent => ({
  externalId: String(id),
  startDate,
  startTime: "07:00:00",
  title: `W${id}`,
  description: null,
  sportType: "Ride",
  workoutDoc: null,
  ...extra,
});

describe("PlannedWorkoutRepository (integration)", () => {
  let ctx: TestContext;
  const repo = (
    userId = USER,
    today = "2026-03-01",
    providerId?: string,
    accessWindow?: AccessWindow,
  ) => new PlannedWorkoutRepository(ctx.db, userId, today, providerId, accessWindow);
  const put = (userId: string, events: PlannedWorkoutEvent[]) =>
    replacePlannedWorkoutSnapshot(ctx.db, {
      userId,
      providerId: PROVIDER,
      window: { from: "2026-03-01", to: "2026-06-30" },
      events,
    });

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${USER}::uuid, 'Up A'), (${OTHER}::uuid, 'Up B')`,
    );
    await ensureProvider(ctx.db, PROVIDER, "Intervals.icu", "https://intervals.icu");
  }, 120_000);
  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.planned_workout`);
    await put(USER, [
      event(1, "2026-03-02", { workoutDoc: doc }),
      event(2, "2026-03-02", { startTime: "05:00:00" }),
      event(3, "2026-05-30"), // inclusive day +90 from 2026-03-01
      event(4, "2026-06-01"), // beyond horizon
      event(5, "2026-02-27"), // past
    ]);
    await put(OTHER, [event(6, "2026-03-03")]);
  });
  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("returns user-scoped days within the inclusive 90-day horizon grouped and ordered by local time", async () => {
    const days = await repo().upcoming();
    expect(days.map((day) => day.date)).toEqual(["2026-03-02", "2026-05-30"]);
    expect(days[0]?.workouts.map((workout) => workout.title)).toEqual(["W2", "W1"]);
  });

  it("retains every authored target type with value/start/end and unit at each leaf", async () => {
    const workout = (await repo().upcoming())[0]?.workouts.find((item) => item.title === "W1");
    expect(workout?.startTime).toBe("07:00");
    expect(workout?.steps).toEqual([
      {
        kind: "step",
        text: "Ramp",
        durationSeconds: 600,
        distanceMeters: 4000,
        targets: [
          { type: "power", value: null, start: 35, end: 55, unit: "%ftp" },
          { type: "heart_rate", value: 150, start: null, end: null, unit: "bpm" },
          { type: "pace", value: null, start: 5.2, end: 4.8, unit: "min/km" },
          { type: "cadence", value: 90, start: null, end: null, unit: "rpm" },
        ],
      },
      {
        kind: "repeat",
        repetitions: 4,
        text: null,
        steps: [
          {
            kind: "step",
            text: null,
            durationSeconds: 300,
            distanceMeters: null,
            targets: [{ type: "power", value: 105, start: null, end: null, unit: "%ftp" }],
          },
          {
            kind: "step",
            text: null,
            durationSeconds: 180,
            distanceMeters: null,
            targets: [{ type: "power", value: 150, start: null, end: null, unit: "w" }],
          },
        ],
      },
    ]);
  });

  it("returns neutral markers for unsupported shapes without leaking vendor JSON", async () => {
    await put(USER, [
      event(7, "2026-03-04", {
        workoutDoc: {
          steps: [
            { mystery: { nested: [1, 2] } },
            { warmup: true, ramp: true },
            { duration: 120, power: { value: 50, units: "%ftp" } },
          ],
        },
      }),
    ]);
    const day = (await repo().upcoming()).find((item) => item.date === "2026-03-04");
    expect(day?.workouts[0]?.steps).toEqual([
      { kind: "unsupported" },
      { kind: "unsupported" },
      {
        kind: "step",
        text: null,
        durationSeconds: 120,
        distanceMeters: null,
        targets: [{ type: "power", value: 50, start: null, end: null, unit: "%ftp" }],
      },
    ]);
  });

  it("filters by optional provider", async () => {
    await put(USER, [event(8, "2026-03-06", { title: "Other provider" })]);
    expect(await repo(USER, "2026-03-01", "missing-provider").upcoming()).toEqual([]);
    // The provider_id foreign key requires a real provider row before a
    // workout for that provider can be inserted.
    await ensureProvider(ctx.db, "missing-provider", "Missing Provider", "https://example.test");
    await replacePlannedWorkoutSnapshot(ctx.db, {
      userId: USER,
      providerId: "missing-provider",
      window: { from: "2026-03-01", to: "2026-06-30" },
      events: [event(9, "2026-03-06")],
    });
    expect(await repo(USER, "2026-03-01", "missing-provider").upcoming()).toMatchObject([
      { workouts: [{ title: "W9" }] },
    ]);
  });

  it("applies the entitlement access window", async () => {
    const limited: AccessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-03-01",
      endDateExclusive: "2026-03-03",
    };
    expect(
      (await repo(USER, "2026-03-01", undefined, limited).upcoming()).flatMap((d) => d.date),
    ).toEqual(["2026-03-02"]);
  });

  it("never returns another user's workouts", async () => {
    const titles = (await repo(OTHER).upcoming()).flatMap((day) =>
      day.workouts.map((workout) => workout.title),
    );
    expect(titles).toEqual(["W6"]);
  });

  it("returns an empty list after source deletion", async () => {
    await put(OTHER, []);
    expect(await repo(OTHER).upcoming()).toEqual([]);
  });

  it("reads an explicit inclusive date range and filters by Intervals.icu sport mapping", async () => {
    await put(USER, [
      event(10, "2026-03-10", { sportType: "Ride", title: "Ride day" }),
      event(11, "2026-03-11", { sportType: "Run", title: "Run day" }),
      event(12, "2026-03-25", { sportType: "Ride", title: "Out of range" }),
    ]);
    const days = await repo().upcoming({
      dateRange: { startDate: "2026-03-10", endDate: "2026-03-20" },
      activityType: "cycling",
    });
    expect(days).toEqual([
      {
        date: "2026-03-10",
        workouts: [expect.objectContaining({ title: "Ride day", sportType: "Ride" })],
      },
    ]);
  });

  it("attaches snapshotImportedAt when Intervals.icu connection or CALENDAR:READ grant is missing", async () => {
    await put(USER, [event(13, "2026-03-12", { title: "Snapshot candidate" })]);
    const disconnected = await repo().upcoming({
      dateRange: { startDate: "2026-03-12", endDate: "2026-03-12" },
    });
    expect(disconnected[0]?.workouts[0]).toEqual(
      expect.objectContaining({
        title: "Snapshot candidate",
        snapshotImportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );

    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_connection (user_id, provider_id)
          VALUES (${USER}::uuid, ${PROVIDER})
          ON CONFLICT DO NOTHING`,
    );
    const connectionOnly = await repo().upcoming({
      dateRange: { startDate: "2026-03-12", endDate: "2026-03-12" },
    });
    expect(connectionOnly[0]?.workouts[0]).toEqual(
      expect.objectContaining({
        title: "Snapshot candidate",
        snapshotImportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );

    await ctx.db.execute(
      sql`INSERT INTO fitness.oauth_token (user_id, provider_id, access_token, expires_at, scopes)
          VALUES (
            ${USER}::uuid,
            ${PROVIDER},
            'test-token',
            '2099-01-01T00:00:00Z',
            'ACTIVITY:READ,WELLNESS:READ'
          )
          ON CONFLICT (user_id, provider_id) DO UPDATE
          SET scopes = EXCLUDED.scopes, access_token = EXCLUDED.access_token`,
    );
    const partialScopes = await repo().upcoming({
      dateRange: { startDate: "2026-03-12", endDate: "2026-03-12" },
    });
    expect(partialScopes[0]?.workouts[0]).toEqual(
      expect.objectContaining({
        title: "Snapshot candidate",
        snapshotImportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );

    await ctx.db.execute(
      sql`UPDATE fitness.oauth_token
          SET scopes = ' ACTIVITY:READ , WELLNESS:READ , CALENDAR:READ '
          WHERE user_id = ${USER}::uuid AND provider_id = ${PROVIDER}`,
    );
    const liveRead = await repo().upcoming({
      dateRange: { startDate: "2026-03-12", endDate: "2026-03-12" },
    });
    expect(liveRead[0]?.workouts[0]).toEqual(
      expect.objectContaining({ title: "Snapshot candidate" }),
    );
    expect(liveRead[0]?.workouts[0]).not.toHaveProperty("snapshotImportedAt");

    // Intervals.icu Update grants return WRITE, which implies the same-category READ.
    // https://forum.intervals.icu/t/intervals-icu-oauth-support/2759
    await ctx.db.execute(
      sql`UPDATE fitness.oauth_token
          SET scopes = ' ACTIVITY:WRITE , WELLNESS:WRITE , CALENDAR:WRITE '
          WHERE user_id = ${USER}::uuid AND provider_id = ${PROVIDER}`,
    );
    const liveWrite = await repo().upcoming({
      dateRange: { startDate: "2026-03-12", endDate: "2026-03-12" },
    });
    expect(liveWrite[0]?.workouts[0]).toEqual(
      expect.objectContaining({ title: "Snapshot candidate" }),
    );
    expect(liveWrite[0]?.workouts[0]).not.toHaveProperty("snapshotImportedAt");

    await ctx.db.execute(
      sql`DELETE FROM fitness.oauth_token
          WHERE user_id = ${USER}::uuid AND provider_id = ${PROVIDER}`,
    );
    await ctx.db.execute(
      sql`DELETE FROM fitness.provider_connection
          WHERE user_id = ${USER}::uuid AND provider_id = ${PROVIDER}`,
    );
  });
});
