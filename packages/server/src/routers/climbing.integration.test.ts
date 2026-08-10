import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { climbingRouter } from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(climbingRouter);
const activityIdRowSchema = z.object({
  id: z.string(),
  external_id: z.string(),
});

describe("Hangboarding climbing router integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('hangboarding-climbing-router-test', 'Hang Ten', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES
          (
            'hangboarding-climbing-router-test', ${TEST_USER_ID}, 'hangboard-climbing-router-session-1',
            'hangboard', 'Hang Ten', '2026-08-07T14:00:00Z'::timestamptz,
            '2026-08-07T14:10:00Z'::timestamptz, 'Repeaters',
            '{"avgHeartRate":120,"maxHeartRate":145,"hangTen":{"planName":"Repeaters","boardName":"Tension Board"}}'::jsonb
          ),
          (
            'hangboarding-climbing-router-test', ${TEST_USER_ID}, 'hangboard-climbing-router-session-2',
            'hangboard', 'Hang Ten', '2026-08-08T14:00:00Z'::timestamptz,
            '2026-08-08T14:15:00Z'::timestamptz, 'Max Hangs',
            '{"avgHeartRate":130,"maxHeartRate":150,"hangTen":{"planName":"Max Hangs","boardName":"Tension Board"}}'::jsonb
          )`,
    );
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
    await testContext?.cleanup();
  });

  it("returns exact server-computed Hangboarding summary totals", async () => {
    const caller = createCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
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
    });
  });
});
const countRowSchema = z.object({
  count: z.string(),
});

describe("climbing router integration", () => {
  let testContext: TestContext;
  let climbingActivityId: string;
  let visibleClimbingActivityId: string;
  let routeActivityId: string;

  beforeAll(async () => {
    const dayInMilliseconds = 24 * 60 * 60 * 1_000;
    const boulderStartedAt = new Date(Date.now() - 2 * dayInMilliseconds).toISOString();
    const routeStartedAt = new Date(Date.now() - dayInMilliseconds).toISOString();
    testContext = await setupTestDatabase();

    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('kaya-export', 'Kaya', ${TEST_USER_ID}),
            ('strava', 'Strava', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const insertedActivities = await executeWithSchema(
      testContext.db,
      activityIdRowSchema,
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
          (
            'kaya-export',
            ${TEST_USER_ID},
            'climbing-router-boulder-session',
            'climbing',
            'rock_climbing',
            ${boulderStartedAt}::timestamptz,
            (${boulderStartedAt}::timestamptz + INTERVAL '90 minutes'),
            'Kaya climbing at Touchstone Pacific Pipe'
          ),
          (
            'kaya-export',
            ${TEST_USER_ID},
            'climbing-router-route-session',
            'climbing',
            'rock_climbing',
            ${routeStartedAt}::timestamptz,
            (${routeStartedAt}::timestamptz + INTERVAL '90 minutes'),
            'Kaya climbing at Mission Cliffs'
          ),
          (
            'strava',
            ${TEST_USER_ID},
            'climbing-router-strava-overlap',
            'climbing',
            'rock_climbing',
            ${boulderStartedAt}::timestamptz,
            (${boulderStartedAt}::timestamptz + INTERVAL '90 minutes'),
            'Morning Rock Climb'
          )
          RETURNING id, external_id`,
    );

    const boulderActivity = insertedActivities.find(
      (activity) => activity.external_id === "climbing-router-boulder-session",
    );
    const routeActivity = insertedActivities.find(
      (activity) => activity.external_id === "climbing-router-route-session",
    );
    if (!boulderActivity || !routeActivity) {
      throw new Error("Failed to seed climbing activities");
    }
    climbingActivityId = boulderActivity.id;
    routeActivityId = routeActivity.id;

    const visibleActivities = await executeWithSchema(
      testContext.db,
      z.object({ id: z.string() }),
      sql`SELECT id::text AS id
          FROM fitness.v_activity
          WHERE ${climbingActivityId}::uuid = ANY(member_activity_ids)`,
    );
    const visibleClimbingActivity = visibleActivities[0];
    if (!visibleClimbingActivity) {
      throw new Error("Failed to resolve the merged climbing activity");
    }
    visibleClimbingActivityId = visibleClimbingActivity.id;

    await testContext.db.execute(
      sql`INSERT INTO fitness.climbing_entry (
            activity_id,
            external_id,
            climb_type,
            grade_system,
            grade,
            sent,
            attempt_count,
            route_name,
            location_name,
            source_name,
            raw
          ) VALUES
          (
            ${climbingActivityId},
            'climbing-router-entry-v2',
            'boulder',
            'v_scale',
            'V2',
            true,
            2,
            'Warmup',
            'Touchstone Pacific Pipe',
            'Kaya',
            '{"ascentType":"Redpoint"}'::jsonb
          ),
          (
            ${climbingActivityId},
            'climbing-router-entry-v4',
            'boulder',
            'v_scale',
            'V4',
            true,
            3,
            'Blue Circuit',
            'Touchstone Pacific Pipe',
            'Kaya',
            '{}'::jsonb
          ),
          (
            ${climbingActivityId},
            'climbing-router-entry-v5-unsent',
            'boulder',
            'v_scale',
            'V5',
            false,
            4,
            'Project',
            'Touchstone Pacific Pipe',
            'Kaya',
            '{}'::jsonb
          ),
          (
            ${routeActivityId},
            'climbing-router-entry-yds',
            'route',
            'yds',
            '5.10a',
            true,
            2,
            'Lead Route',
            'Mission Cliffs',
            'Kaya',
            '{}'::jsonb
          )`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("returns grade progression, volume, and session summaries from real Postgres rows", async () => {
    const caller = createCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    const [gradeProgression, volumeByGrade, sessionSummary] = await Promise.all([
      caller.gradeProgression({ days: 30 }),
      caller.volumeByGrade({ days: 30 }),
      caller.sessionSummary({ days: 30 }),
    ]);

    expect(gradeProgression).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ climbType: "boulder", grade: "V4", gradeSortValue: 4 }),
        expect.objectContaining({ climbType: "route", grade: "5.10a", gradeSortValue: 5101 }),
      ]),
    );
    expect(volumeByGrade).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ climbType: "boulder", grade: "V4", attempts: 3, sends: 1 }),
        expect.objectContaining({ climbType: "boulder", grade: "V5", attempts: 4, sends: 0 }),
        expect.objectContaining({ climbType: "route", grade: "5.10a", attempts: 2, sends: 1 }),
      ]),
    );
    expect(sessionSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: visibleClimbingActivityId,
          attempts: 9,
          sends: 2,
          hardestBoulderGrade: "V4",
          hardestRouteGrade: null,
        }),
        expect.objectContaining({
          activityId: routeActivityId,
          attempts: 2,
          sends: 1,
          hardestBoulderGrade: null,
          hardestRouteGrade: "5.10a",
        }),
      ]),
    );
  });

  it("rejects non-positive climbing attempt counts", async () => {
    await expect(
      testContext.db.execute(sql`
        INSERT INTO fitness.climbing_entry (
          activity_id, climb_type, grade_system, grade, sent, attempt_count
        ) VALUES (
          ${routeActivityId}, 'route', 'yds', '5.9', false, 0
        )
      `),
    ).rejects.toThrow("Failed query");
  });

  it("returns climbing entries attached to a merged activity member", async () => {
    const caller = createCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    await expect(caller.activityEntries({ id: visibleClimbingActivityId })).resolves.toEqual([
      expect.objectContaining({
        climbType: "boulder",
        grade: "V2",
        routeName: "Warmup",
        sent: true,
        attemptCount: 2,
        ascentType: "Redpoint",
      }),
      expect.objectContaining({
        climbType: "boulder",
        grade: "V4",
        routeName: "Blue Circuit",
        sent: true,
        attemptCount: 3,
        ascentType: null,
      }),
      expect.objectContaining({
        climbType: "boulder",
        grade: "V5",
        routeName: "Project",
        sent: false,
        attemptCount: 4,
        ascentType: null,
      }),
    ]);
  });

  it("logs and reads a canonical finger-loading protocol with server-derived effective load", async () => {
    const caller = createCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    const logged = await caller.logFingerLoading({
      bodyweightKg: 72,
      edgeSizeMm: 20,
      exercise: "max_hang",
      externalLoadKg: 18,
      gripPosition: "half_crimp",
      holdDurationSeconds: 10,
      laterality: "both",
      notes: "Felt controlled",
      restIntervalSeconds: 180,
      rpe: 8,
      setCount: 5,
      startedAt: new Date().toISOString(),
    });

    expect(logged).toMatchObject({
      bodyweightKg: 72,
      effectiveLoadKg: 90,
      exercise: "max_hang",
      setCount: 5,
    });
    await expect(caller.fingerLoadingHistory({ days: 1 })).resolves.toEqual([
      expect.objectContaining({
        activityId: logged.activityId,
        effectiveLoadKg: 90,
        notes: "Felt controlled",
      }),
    ]);

    await testContext.db.execute(
      sql`UPDATE fitness.activity
          SET deleted_at = NOW()
          WHERE id = ${logged.activityId}`,
    );

    await expect(caller.fingerLoadingHistory({ days: 2 })).resolves.toEqual([]);
  });

  it("logs individual climbing attempts and derives aggregate entry detail", async () => {
    const caller = createCaller({
      db: testContext.db,
      userId: TEST_USER_ID,
      timezone: "UTC",
    });

    const logged = await caller.logClimbingSession({
      climbs: [
        {
          attempts: [
            { failureReason: "technique", outcome: "failed" },
            { failureReason: "pumped", outcome: "failed" },
            { failureReason: null, outcome: "sent" },
          ],
          climbType: "boulder",
          grade: "V6",
          gradeSystem: "v_scale",
          holdType: "crimp",
          routeName: "Moon Arete",
          wallAngleDegrees: 35,
        },
      ],
      locationName: "Test Board",
      startedAt: new Date().toISOString(),
    });

    expect(logged.climbs).toEqual([expect.objectContaining({ attemptCount: 3, sent: true })]);
    await expect(caller.activityEntries({ id: logged.activityId })).resolves.toEqual([
      expect.objectContaining({
        attempts: [
          expect.objectContaining({ failureReason: "technique", outcome: "failed" }),
          expect.objectContaining({ failureReason: "pumped", outcome: "failed" }),
          expect.objectContaining({ failureReason: null, outcome: "sent" }),
        ],
        attemptCount: 3,
        holdType: "crimp",
        sent: true,
        wallAngleDegrees: 35,
      }),
    ]);
  });

  it("cascades climbing entries when an activity is deleted", async () => {
    await testContext.db.execute(
      sql`DELETE FROM fitness.activity WHERE id = ${climbingActivityId}`,
    );

    const rows = await executeWithSchema(
      testContext.db,
      countRowSchema,
      sql`SELECT COUNT(*)::text AS count
          FROM fitness.climbing_entry
          WHERE activity_id = ${climbingActivityId}`,
    );

    expect(rows[0]?.count).toBe("0");

    const remainingActivities = await executeWithSchema(
      testContext.db,
      countRowSchema,
      sql`SELECT COUNT(*)::text AS count
          FROM fitness.activity
          WHERE id = ${climbingActivityId}`,
    );

    expect(remainingActivities[0]?.count).toBe("0");
  });
});
