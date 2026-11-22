import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type PlannedWorkoutEvent,
  replacePlannedWorkoutSnapshot,
} from "./planned-workout-repository.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";
import { executeWithSchema } from "./typed-sql.ts";

const USER = "00000000-0000-4000-8000-0000000000d1";
const OTHER = "00000000-0000-4000-8000-0000000000d2";
const PROVIDER = "intervals.icu";

const repeatDoc = {
  steps: [
    { duration: 600, power: { value: 55, units: "%ftp" } },
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
  startTime: "06:30:00",
  title: `Session ${id}`,
  description: "notes",
  sportType: "Ride",
  workoutDoc: null,
  ...extra,
});

describe("replacePlannedWorkoutSnapshot (integration)", () => {
  let ctx: TestContext;
  const replace = (
    events: unknown,
    window = { from: "2026-03-01", to: "2026-03-31" },
    userId = USER,
  ) =>
    replacePlannedWorkoutSnapshot(ctx.db, {
      userId,
      providerId: PROVIDER,
      window,
      events,
    });
  const rows = (userId = USER) =>
    executeWithSchema(
      ctx.db,
      z.object({
        external_id: z.string(),
        start_date: z.string(),
        start_time: z.string().nullable(),
        title: z.string().nullable(),
        workout_doc: z.unknown(),
      }),
      sql`SELECT external_id, start_date::text AS start_date, start_time::text AS start_time, title, workout_doc
          FROM fitness.planned_workout WHERE user_id = ${userId}::uuid AND provider_id = ${PROVIDER}
          ORDER BY external_id`,
    );
  const createdAt = (externalId: string) =>
    executeWithSchema(
      ctx.db,
      z.object({ created_at: z.string() }),
      sql`SELECT created_at::text AS created_at FROM fitness.planned_workout
          WHERE user_id = ${USER}::uuid AND provider_id = ${PROVIDER} AND external_id = ${externalId}`,
    );

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${USER}::uuid, 'Plan A'), (${OTHER}::uuid, 'Plan B')`,
    );
    await ensureProvider(ctx.db, PROVIDER, "Intervals.icu", "https://intervals.icu");
  }, 120_000);
  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.planned_workout`);
  });
  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("upserts by (user, provider, external id) and keeps the raw structured document", async () => {
    await replace([event(1, "2026-03-10", { workoutDoc: repeatDoc })]);
    await replace([event(1, "2026-03-10", { title: "Renamed", workoutDoc: repeatDoc })]);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title: "Renamed", start_time: "06:30:00" });
    expect(stored[0]?.workout_doc).toEqual(repeatDoc);
  });

  it("keeps identity and created_at when an event moves across days", async () => {
    await replace([event(1, "2026-03-10")]);
    await ctx.db.execute(sql`
      UPDATE fitness.planned_workout SET created_at = '2020-01-01T00:00:00Z'
      WHERE user_id = ${USER}::uuid AND provider_id = ${PROVIDER} AND external_id = '1'
    `);
    await replace([event(1, "2026-03-12")]);
    expect(await rows()).toMatchObject([{ external_id: "1", start_date: "2026-03-12" }]);
    expect((await createdAt("1"))[0]?.created_at).toContain("2020-01-01");
  });

  it("reports the actual number of rows removed, not the incoming list size", async () => {
    await replace([event(1, "2026-03-05"), event(2, "2026-03-20")]);
    const partial = await replace([event(2, "2026-03-20")]);
    expect(partial).toEqual({ upserted: 1, removed: 1 });
    expect((await rows()).map((row) => row.external_id)).toEqual(["2"]);
    const empty = await replace([]);
    expect(empty).toEqual({ upserted: 0, removed: 1 });
    expect(await rows()).toEqual([]);
  });

  it("removes absent events only inside the successful window", async () => {
    await replace([event(1, "2026-03-05"), event(2, "2026-03-20")]);
    await replace([event(3, "2026-04-10")], { from: "2026-04-01", to: "2026-04-30" });
    expect((await rows()).map((row) => row.external_id)).toEqual(["1", "2", "3"]);
    await replace([event(2, "2026-03-20")]);
    expect((await rows()).map((row) => row.external_id)).toEqual(["2", "3"]);
  });

  it("treats a valid empty snapshot as authoritative", async () => {
    await replace([event(1, "2026-03-05")]);
    await replace([]);
    expect(await rows()).toEqual([]);
  });

  it.each([
    ["non-array response", { events: [] }],
    ["event without external id", [event(1, "2026-03-05"), { startDate: "2026-03-06" }]],
    ["event with invalid date", [event(1, "2026-03-05"), event(2, "2026-02-30")]],
    ["duplicate identities", [event(1, "2026-03-05"), event(1, "2026-03-06")]],
  ])("preserves the previous snapshot for %s", async (_name, bad) => {
    await replace([event(9, "2026-03-07")]);
    await expect(replace(bad)).rejects.toThrow();
    expect((await rows()).map((row) => row.external_id)).toEqual(["9"]);
  });

  it("ignores out-of-window events for writes and absence", async () => {
    await replace([event(1, "2026-03-05")]);
    await replace([event(1, "2026-03-05"), event(7, "2026-02-27")]);
    expect((await rows()).map((row) => row.external_id)).toEqual(["1"]);
  });

  it("keeps the authored local day at UTC and DST boundaries", async () => {
    await replace([
      event(1, "2026-03-08", { startTime: "23:30:00" }),
      event(2, "2026-03-08", { startTime: "02:30:00" }),
      event(3, "2026-03-09", { startTime: "00:15:00" }),
    ]);
    expect(await rows()).toMatchObject([
      { external_id: "1", start_date: "2026-03-08", start_time: "23:30:00" },
      { external_id: "2", start_date: "2026-03-08", start_time: "02:30:00" },
      { external_id: "3", start_date: "2026-03-09", start_time: "00:15:00" },
    ]);
  });

  it("retains unsupported structured shapes as raw without failing the event", async () => {
    const odd = { steps: "free text", extra: { nested: [1, 2] } };
    await replace([event(1, "2026-03-05", { workoutDoc: odd })]);
    expect((await rows())[0]?.workout_doc).toEqual(odd);
  });

  it("scopes writes and absence to the user and provider", async () => {
    await replace([event(1, "2026-03-05")]);
    await replace([event(1, "2026-03-05")], undefined, OTHER);
    await replace([], undefined, OTHER);
    expect(await rows()).toHaveLength(1);
    expect(await rows(OTHER)).toEqual([]);
  });

  it("erases with the provider source and with the user profile", async () => {
    await replace([event(1, "2026-03-05")]);
    await replace([event(2, "2026-03-05")], undefined, OTHER);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id = ${OTHER}::uuid`);
    expect(await rows(OTHER)).toEqual([]);
    expect(await rows()).toHaveLength(1);
    // Source deletion path (provider-data-deletion) coverage is added with the Task 4A
    // implementation next to the existing provider deletion integration tests.
  });
});
