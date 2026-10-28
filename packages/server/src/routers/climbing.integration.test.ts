import { randomUUID } from "node:crypto";
import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { queryCache } from "dofek/lib/cache";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climb, climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";
import {
  climbingTestDate,
  seedClimbingActivity,
  seedClimbingLog,
} from "../repositories/climbing-integration-test-helpers.ts";
import { CacheTTL, requestCacheKey } from "../trpc.ts";
import { activityRouter } from "./activity.ts";
import { buildTestAnalyticsTableStatement } from "./clickhouse-integration-test-models.ts";
import { climbingRouter } from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(climbingRouter);
const createActivityCaller = createTestCallerFactory(activityRouter);
const hangboardingActivityIdRowSchema = z.object({
  id: z.string(),
  group_id: z.string(),
  external_id: z.string(),
  started_at: z.string(),
});
describe("Hangboarding climbing router integration", () => {
  const database = `hangboarding_router_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const rewrite = (query: string) => query.replaceAll("analytics.", `${database}.`);
  const sensorStore = new ClickHouseActivitySensorStore({
    query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    command: (options) => client.command({ ...options, query: rewrite(options.query) }),
  });
  let testContext: TestContext;
  let firstDate: string;
  let secondDate: string;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('hangboarding-climbing-router-test', 'Hang Ten', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    const activities = await executeWithSchema(
      testContext.db,
      hangboardingActivityIdRowSchema,
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES
          (
            'hangboarding-climbing-router-test', ${TEST_USER_ID}, 'hangboard-climbing-router-session-1',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '2 days',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '10 minutes', 'Repeaters',
            '{"hangTen":{"planName":"Repeaters","boardName":"Tension Board"}}'::jsonb
          ),
          (
            'hangboarding-climbing-router-test', ${TEST_USER_ID}, 'hangboard-climbing-router-session-2',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '15 minutes', 'Max Hangs',
            '{"hangTen":{"planName":"Max Hangs","boardName":"Tension Board"}}'::jsonb
          )
          RETURNING id::text AS id, group_id::text AS group_id, external_id, started_at::text AS started_at`,
    );
    const firstActivity = activities.find(
      (activity) => activity.external_id === "hangboard-climbing-router-session-1",
    );
    const secondActivity = activities.find(
      (activity) => activity.external_id === "hangboard-climbing-router-session-2",
    );
    if (!firstActivity || !secondActivity) {
      throw new Error("Failed to seed Hangboarding climbing router activities");
    }
    firstDate = new Date(firstActivity.started_at).toISOString().slice(0, 10);
    secondDate = new Date(secondActivity.started_at).toISOString().slice(0, 10);
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: rewrite(buildTestAnalyticsTableStatement("analytics.activity_summary")),
    });
    if (!client.insert) throw new Error("ClickHouse test client requires inserts");
    await client.insert({
      table: `${database}.activity_summary`,
      format: "JSONEachRow",
      values: [firstActivity, secondActivity].map((activity, index) => ({
        activity_id: activity.group_id,
        user_id: TEST_USER_ID,
        canonical_type: "hangboard",
        started_at: new Date(activity.started_at).toISOString().replace("T", " ").slice(0, 19),
        avg_hr: index === 0 ? 120 : 130,
        max_hr: index === 0 ? 145 : 150,
        hr_sample_count: 10,
        sample_count: 10,
      })),
    });
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_interval (
            activity_id, interval_index, interval_type, started_at, ended_at
          )
          SELECT activity.id, intervals.interval_index, intervals.interval_type,
                 activity.started_at + intervals.started_offset,
                 activity.started_at + intervals.ended_offset
          FROM fitness.activity AS activity
          CROSS JOIN (VALUES
            (0, 'work', INTERVAL '0 seconds', INTERVAL '7 seconds'),
            (1, 'rest', INTERVAL '7 seconds', INTERVAL '60 seconds')
          ) AS intervals(interval_index, interval_type, started_offset, ended_offset)
          WHERE activity.provider_id = 'hangboarding-climbing-router-test'
            AND activity.external_id = 'hangboard-climbing-router-session-1'
          UNION ALL
          SELECT activity.id, intervals.interval_index, intervals.interval_type,
                 activity.started_at + intervals.started_offset,
                 activity.started_at + intervals.ended_offset
          FROM fitness.activity AS activity
          CROSS JOIN (VALUES
            (0, 'work', INTERVAL '0 seconds', INTERVAL '10 seconds'),
            (1, 'rest', INTERVAL '10 seconds', INTERVAL '60 seconds')
          ) AS intervals(interval_index, interval_type, started_offset, ended_offset)
          WHERE activity.provider_id = 'hangboarding-climbing-router-test'
            AND activity.external_id = 'hangboard-climbing-router-session-2'`,
    );
  }, 60_000);

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
    await testContext?.cleanup();
  });

  it("returns exact server-computed Hangboarding summary totals", async () => {
    const caller = createCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
      sensorStore,
      cacheMode: "refresh",
    });
    await expect(caller.hangboardingSummary({ days: 30 })).resolves.toMatchObject({
      sessionCount: 2,
      totalDurationSeconds: 1500,
      averageDurationSeconds: 750,
      totalWorkDurationSeconds: 17,
      totalRestDurationSeconds: 103,
      workIntervalCount: 2,
      averageHeartRate: 125,
      peakHeartRate: 150,
      daily: expect.arrayContaining([
        expect.objectContaining({ date: firstDate, durationSeconds: 600 }),
        expect.objectContaining({ date: secondDate, durationSeconds: 900 }),
      ]),
    });
  });
});

describe("climbing log router PostgreSQL integration", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    for (const provider of ["kaya-export", "strava", "mountain-project"])
      await ensureProvider(context.db, provider, provider, undefined, TEST_USER_ID);
  });
  afterEach(async () => {
    await queryCache.invalidateByPrefix(`${TEST_USER_ID}:climbing.`);
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity).where(eq(activity.userId, TEST_USER_ID));
  });
  afterAll(async () => context.cleanup());
  const caller = (timezone = "UTC") =>
    createCaller({ db: context.db, userId: TEST_USER_ID, timezone, cacheMode: "refresh" });
  async function log(
    externalId: string,
    value: string,
    count = 1,
    activityId?: string,
    completed = true,
  ) {
    return seedClimbingLog(context.db, "kaya-export", {
      externalId,
      climbedOn: await climbingTestDate(context.db),
      activityId,
      discipline: "rock_climbing",
      climb: {
        externalId: value,
        name: value,
        kind: "boulder",
        setting: "indoor",
        publishedGrades: [{ value, system: "v_scale" }],
        areas: [{ externalId: "gym", name: "Gym" }],
      },
      attempts: [
        {
          scope: "climb",
          ...(completed
            ? { sourceResult: "Send", qualifier: "free-send" as const }
            : { sourceResult: "failed" as const }),
        },
      ],
      reportedAttemptCounts: [{ scope: "climb", count }],
    });
  }
  it("returns real summaries and recorded attempts after a cached contract change", async () => {
    const outing = await seedClimbingActivity(context.db, "kaya-export", "session");
    await log("v2", "V2", 2, outing.id);
    await log("v4", "V4", 3, outing.id);
    await log("v5", "V5", 4, outing.id, false);
    const oldKey = requestCacheKey(TEST_USER_ID, "volumeByGrade", { days: 30 }, "UTC");
    await queryCache.set(oldKey, [{ attempts: 99, sends: 99 }], CacheTTL.LONG);
    const [volume, progression, summaries] = await Promise.all([
      caller().volumeByGrade({ days: 30 }),
      caller().gradeProgression({ days: 30 }),
      caller().sessionSummary({ days: 30 }),
    ]);
    await queryCache.invalidate(oldKey);
    expect(volume).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          climbKind: "boulder",
          grade: "V4",
          recordedAttempts: 3,
          sends: 1,
        }),
        expect.objectContaining({ grade: "V5", recordedAttempts: 4, sends: 0 }),
      ]),
    );
    expect(progression).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          climbKind: "boulder",
          grades: expect.arrayContaining([expect.objectContaining({ grade: "V4" })]),
        }),
      ]),
    );
    expect(summaries).toEqual([
      expect.objectContaining({
        activityId: outing.groupId,
        attempts: 9,
        sends: 2,
        hardestBoulderGrade: "V4",
      }),
    ]);
  });
  it("groups climbing attempts by week", async () => {
    const outing = await seedClimbingActivity(context.db, "kaya-export", "weekly-volume");
    await log("weekly-v2", "V2", 2, outing.id);
    await log("weekly-v4", "V4", 3, outing.id);
    expect(await caller().volumeOverTime({ days: 30 })).toEqual([
      expect.objectContaining({ attempts: 5 }),
    ]);
    expect(await caller().volumeOverTime({ days: null })).toEqual([
      expect.objectContaining({ attempts: 5 }),
    ]);
    expect(await caller().volumeOverTime({ days: 30, setting: "outdoor" })).toEqual([]);
  });
  it("shows time but leaves attempts unknown when an activity has no climbing logs", async () => {
    await seedClimbingActivity(context.db, "kaya-export", "weekly-no-logs");
    expect(await caller().volumeOverTime({ days: 30 })).toEqual([
      expect.objectContaining({ attempts: null, minutes: expect.any(Number) }),
    ]);
  });
  it("serves the canonical attempt graph through group and member activity identities", async () => {
    const outing = await seedClimbingActivity(context.db, "kaya-export", "session");
    const id = await log("v4", "V4", 3, outing.id);
    for (const activityId of [outing.groupId, outing.id])
      expect(await caller().activityLogEntries({ activityId })).toEqual([
        expect.objectContaining({
          id,
          climb: expect.objectContaining({ name: "V4" }),
          recordedClimbAttemptCount: 3,
          recordedClimbOutcome: "completed",
          attempts: expect.any(Array),
        }),
      ]);
  });
  it("matches and attaches one same-day log while preserving the source date", async () => {
    const outing = await seedClimbingActivity(context.db, "kaya-export", "session");
    const id = await log("v4", "V4");
    expect(await caller().unattachedClimbingLogEntries({ activityId: outing.groupId })).toEqual([
      expect.objectContaining({ id, displayGrade: "V4" }),
    ]);
    await expect(
      caller().attachClimbingLogEntry({ activityId: outing.groupId, climbingLogEntryId: id }),
    ).resolves.toEqual({ attached: true });
    await expect(
      caller().attachClimbingLogEntry({ activityId: outing.groupId, climbingLogEntryId: id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await caller().unattachedClimbingLogEntries({ activityId: outing.groupId })).toEqual([]);
    expect((await caller().activityLogEntries({ activityId: outing.groupId }))[0]?.climbedOn).toBe(
      await climbingTestDate(context.db),
    );
  });
  it("allows a mountaineering log on a hiking activity", async () => {
    const outing = await seedClimbingActivity(context.db, "strava", "hike");
    await context.db
      .update(activity)
      .set({ canonicalType: "hiking" })
      .where(eq(activity.id, outing.id));
    const id = await seedClimbingLog(context.db, "mountain-project", {
      externalId: "summit",
      climbedOn: await climbingTestDate(context.db),
      discipline: "mountaineering",
      climb: { externalId: "peak", name: "Peak", kind: "summit" },
      attempts: [{ scope: "climb", sourceResult: "completed" }],
    });
    await caller().attachClimbingLogEntry({ activityId: outing.groupId, climbingLogEntryId: id });
    expect(await caller().activityLogEntries({ activityId: outing.groupId })).toEqual([
      expect.objectContaining({ discipline: "mountaineering", recordedClimbOutcome: "completed" }),
    ]);
    expect(await caller().volumeByGrade({ days: 30 })).toEqual([]);
  });
  it("rejects cross-user and ineligible activity targets with actionable errors", async () => {
    const outing = await seedClimbingActivity(context.db, "strava", "run");
    await context.db
      .update(activity)
      .set({ canonicalType: "running" })
      .where(eq(activity.id, outing.id));
    const id = await log("v4", "V4");
    await expect(
      caller().attachClimbingLogEntry({ activityId: outing.groupId, climbingLogEntryId: id }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Choose a climbing or hiking activity to attach this climbing log.",
    });
    const otherUser = "b0000000-0000-4000-8000-000000000001";
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id,name) VALUES (${otherUser},'Other user') ON CONFLICT DO NOTHING`,
    );
    const [other] = await context.db
      .insert(activity)
      .values({
        userId: otherUser,
        providerId: "strava",
        externalId: "other-user",
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date(),
      })
      .returning();
    if (!other?.groupId) throw new Error("Expected other activity group");
    await expect(caller().activityLogEntries({ activityId: other.groupId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller().unattachedClimbingLogEntries({ activityId: other.groupId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await context.db.delete(activity).where(eq(activity.id, other.id));
  });
  it("matches the same displayed date across UTC midnight", async () => {
    const outing = await seedClimbingActivity(
      context.db,
      "strava",
      "midnight",
      new Date("2026-01-02T00:30:00Z"),
    );
    const id = await seedClimbingLog(context.db, "mountain-project", {
      externalId: "midnight-log",
      climbedOn: "2026-01-01",
      attempts: [{ scope: "climb" }],
    });
    const detail = await createActivityCaller({
      db: context.db,
      userId: TEST_USER_ID,
      timezone: "America/Los_Angeles",
    }).byId({ id: outing.groupId });
    expect(detail.displayedDate).toBe("2026-01-01");
    expect(
      await caller("America/Los_Angeles").unattachedClimbingLogEntries({
        activityId: outing.groupId,
      }),
    ).toEqual([expect.objectContaining({ id })]);
  });
  it("unlinks logs after physical activity deletion without losing recorded attempts", async () => {
    const outing = await seedClimbingActivity(context.db, "kaya-export", "delete");
    const id = await log("v4", "V4", 3, outing.id);
    await context.db.delete(activity).where(eq(activity.id, outing.id));
    expect(
      (await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.id, id)))[0],
    ).toMatchObject({ activityId: null, climbedOn: await climbingTestDate(context.db) });
    expect(await caller().volumeByGrade({ days: 30 })).toEqual([
      expect.objectContaining({ recordedAttempts: 3, sends: 1 }),
    ]);
  });
});
