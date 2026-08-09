import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { backfillActivityOverviewAvailability } from "../../../../src/db/activity-overview-availability-backfill.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import { ActivityRepository, type ActivitySensorStore } from "./activity-repository.ts";
import { TrainingRepository } from "./training-repository.ts";

const AUTHORIZED_RUN_ID = "11111111-1111-4111-8111-111111111111";
const AUTHORIZED_WALK_ID = "22222222-2222-4222-8222-222222222222";
const MEASURED_ZERO_RUN_ID = "77777777-7777-4777-8777-777777777777";
const PREVIOUS_WINDOW_START_ID = "99999999-9999-4999-8999-999999999999";
const CURRENT_WINDOW_START_ID = "88888888-8888-4888-8888-888888888888";
const UNAUTHORIZED_RIDE_ID = "33333333-3333-4333-8333-333333333333";
const BEFORE_LOCAL_ACCESS_ID = "44444444-4444-4444-8444-444444444444";
const BEFORE_LOCAL_END_ID = "55555555-5555-4555-8555-555555555555";
const BOUNDARY_USER_ID = "60606060-6060-4060-8060-606060606060";
const ACCESS_WINDOW: AccessWindow = {
  kind: "limited",
  paid: false,
  reason: "free_signup_week",
  startDate: "2026-03-10",
  endDateExclusive: "2026-03-17",
};
const FULL_ACCESS_WINDOW: AccessWindow = {
  kind: "full",
  paid: true,
  reason: "paid_grant",
};
const preservedBackfillFieldsSchema = z.array(
  z.object({
    centroid_lat: z.coerce.number(),
    centroid_lng: z.coerce.number(),
    sample_count: z.coerce.number(),
  }),
);
const activityProcessingFreshnessSchema = z.array(
  z.object({
    last_processed_at: z.string(),
  }),
);

describe("activity visibility consistency", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('issue_2060', 'Issue 2060', ${TEST_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${BOUNDARY_USER_ID}, 'Issue 2060 Boundary User')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('issue_2060_boundary', 'Issue 2060 Boundary', ${BOUNDARY_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
          (
            ${AUTHORIZED_RUN_ID}, 'issue_2060', ${TEST_USER_ID}, 'authorized-run', 'running', 'running',
            '2026-03-15T10:00:00Z', '2026-03-15T10:45:00Z', 'Authorized Run'
          ),
          (
            ${AUTHORIZED_WALK_ID}, 'issue_2060', ${TEST_USER_ID}, 'authorized-walk', 'walking', 'walking',
            '2026-03-16T10:00:00Z', '2026-03-16T10:30:00Z', 'Authorized Walk'
          ),
          (
            ${MEASURED_ZERO_RUN_ID}, 'issue_2060', ${TEST_USER_ID}, 'measured-zero-run', 'running', 'running',
            '2026-03-14T10:00:00Z', '2026-03-14T10:15:00Z', 'Measured Zero Run'
          ),
          (
            ${PREVIOUS_WINDOW_START_ID}, 'issue_2060', ${TEST_USER_ID}, 'previous-window-start', 'running',
            'running',
            '2026-03-02T10:00:00Z', '2026-03-02T10:15:00Z', 'Previous Window Start'
          ),
          (
            ${CURRENT_WINDOW_START_ID}, 'issue_2060', ${TEST_USER_ID}, 'current-window-start', 'running',
            'running',
            '2026-03-09T10:00:00Z', '2026-03-09T10:15:00Z', 'Current Window Start'
          ),
          (
            ${UNAUTHORIZED_RIDE_ID}, 'issue_2060', ${TEST_USER_ID}, 'unauthorized-ride', 'cycling', 'cycling',
            '2026-02-15T10:00:00Z', '2026-02-15T11:30:00Z', 'Unauthorized Ride'
          ),
          (
            ${BEFORE_LOCAL_ACCESS_ID}, 'issue_2060_boundary', ${BOUNDARY_USER_ID},
            'before-local-access', 'running', 'running',
            '2026-03-10T06:30:00Z', '2026-03-10T06:45:00Z', 'Before Local Access'
          ),
          (
            ${BEFORE_LOCAL_END_ID}, 'issue_2060_boundary', ${BOUNDARY_USER_ID},
            'before-local-end', 'running', 'running',
            '2026-03-17T06:30:00Z', '2026-03-17T06:45:00Z', 'Before Local End'
          )`,
    );
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    await syncClickHouseTestActivitySensorStore(testContext);
    // The final running overview includes both run fixtures; keep both canonical
    // summaries measured so the assertion isolates the backfilled walking row.
    await seedClickHouseMetricStreamRows(testContext, [
      {
        activityId: AUTHORIZED_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-15T10:00:00Z",
        channel: "location",
        providerId: "issue_2060",
        sourceType: "api",
        point: "(-122.0,37.0)",
      },
      {
        activityId: AUTHORIZED_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-15T10:01:00Z",
        channel: "location",
        providerId: "issue_2060",
        sourceType: "api",
        point: "(-122.0,37.0)",
      },
      {
        activityId: AUTHORIZED_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-15T10:00:00Z",
        channel: "altitude",
        providerId: "issue_2060",
        sourceType: "api",
        scalar: 100,
      },
      {
        activityId: AUTHORIZED_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-15T10:01:00Z",
        channel: "altitude",
        providerId: "issue_2060",
        sourceType: "api",
        scalar: 100,
      },
      {
        activityId: MEASURED_ZERO_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-14T10:00:00Z",
        channel: "location",
        providerId: "issue_2060",
        sourceType: "api",
        point: "(-122.0,37.0)",
      },
      {
        activityId: MEASURED_ZERO_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-14T10:01:00Z",
        channel: "location",
        providerId: "issue_2060",
        sourceType: "api",
        point: "(-122.0,37.0)",
      },
      {
        activityId: MEASURED_ZERO_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-14T10:00:00Z",
        channel: "altitude",
        providerId: "issue_2060",
        sourceType: "api",
        scalar: 100,
      },
      {
        activityId: MEASURED_ZERO_RUN_ID,
        userId: TEST_USER_ID,
        recordedAt: "2026-03-14T10:01:00Z",
        channel: "altitude",
        providerId: "issue_2060",
        sourceType: "api",
        scalar: 100,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("keeps calendar, overview, detail, and training on the same authorized activities", async () => {
    const calendarRepository = new ActivitiesCalendarRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      ACCESS_WINDOW,
    );
    const activityRepository = new ActivityRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      ACCESS_WINDOW,
      sensorStore,
    );
    const trainingRepository = new TrainingRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      ACCESS_WINDOW,
    );

    const calendar = await calendarRepository.getWeekList({
      weeks: 8,
      endDate: "2026-03-20",
    });
    const overview = await calendarRepository.getActivityOverview({
      weeks: 8,
      endDate: "2026-03-20",
    });
    const unavailableOverview = await calendarRepository.getActivityOverview({
      weeks: 8,
      endDate: "2026-03-20",
      activityType: "walking",
    });
    const training = await trainingRepository.getActivityStatsAndWeeklyVolume(null);
    const authorizedRun = calendar
      .flatMap((day) => day.activities)
      .find((activity) => activity.id === AUTHORIZED_RUN_ID);
    const processingFreshnessResult = await getClickHouseTestClient(testContext).query({
      query: `SELECT
          toString(
            greatest(
              activity.refreshed_at,
              coalesce(summary.refreshed_at, activity.refreshed_at)
            )
          ) AS last_processed_at
        FROM analytics.deduped_activities AS activity FINAL
        LEFT JOIN analytics.activity_summary AS summary
          ON summary.user_id = activity.user_id
         AND summary.activity_id = activity.activity_id
        WHERE activity.activity_id = {activityId:UUID}`,
      query_params: { activityId: AUTHORIZED_RUN_ID },
      format: "JSONEachRow",
    });
    const processingFreshness = activityProcessingFreshnessSchema.parse(
      await processingFreshnessResult.json(),
    );

    expect(calendar.flatMap((day) => day.activities.map((activity) => activity.id))).toEqual([
      AUTHORIZED_WALK_ID,
      AUTHORIZED_RUN_ID,
      MEASURED_ZERO_RUN_ID,
    ]);
    expect(authorizedRun?.source).toEqual({
      primarySourceLabel: "issue_2060",
      sourceCount: 1,
      overlapSummary: null,
    });
    expect(new Date(authorizedRun?.lastProcessedAt ?? "").getTime()).toBe(
      new Date(processingFreshness[0]?.last_processed_at ?? "").getTime(),
    );
    expect(overview).toEqual({
      activityCount: 3,
      totalMinutes: 90,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: ["running", "walking"],
      comparison: {
        periodLabel: "previous 8 weeks",
        activityCount: { magnitude: 3, trend: "higher" },
        totalMinutes: { magnitude: 90, trend: "higher" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Previous period: Distance not recorded",
          },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Previous period: Elevation gain not recorded",
          },
        },
      },
    });
    expect(unavailableOverview).toEqual({
      activityCount: 1,
      totalMinutes: 30,
      totalDistanceMeters: null,
      totalDistanceState: {
        status: "missing",
        reason: "Distance was not recorded for every activity.",
      },
      totalElevationGainM: null,
      totalElevationState: {
        status: "missing",
        reason: "Elevation gain was not recorded for every activity.",
      },
      activityTypes: ["running", "walking"],
      comparison: {
        periodLabel: "previous 8 weeks",
        activityCount: { magnitude: 1, trend: "higher" },
        totalMinutes: { magnitude: 30, trend: "higher" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Distance was not recorded for every activity.",
          },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Elevation gain was not recorded for every activity.",
          },
        },
      },
    });
    await expect(activityRepository.findById(AUTHORIZED_RUN_ID)).resolves.toMatchObject({
      id: AUTHORIZED_RUN_ID,
      name: "Authorized Run",
    });
    await expect(activityRepository.findById(UNAUTHORIZED_RIDE_ID)).resolves.toBeNull();
    expect(training.activities.map((activity) => activity.id).sort()).toEqual(
      [AUTHORIZED_RUN_ID, AUTHORIZED_WALK_ID, MEASURED_ZERO_RUN_ID].sort(),
    );
    expect(training.weeklyVolume).toHaveLength(2);
    expect(training.weeklyVolume).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonical_type: "running", count: 2 }),
        expect.objectContaining({ canonical_type: "walking", count: 1 }),
      ]),
    );
  });

  it("does not leak unauthorized totals or types through an activity-type filter", async () => {
    const repository = new ActivitiesCalendarRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      ACCESS_WINDOW,
    );

    await expect(
      repository.getActivityOverview({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "cycling",
      }),
    ).resolves.toEqual({
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: null,
      totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      totalElevationGainM: null,
      totalElevationState: { status: "missing", reason: "Elevation gain not recorded" },
      activityTypes: ["running", "walking"],
      comparison: {
        periodLabel: "previous 8 weeks",
        activityCount: { magnitude: 0, trend: "unchanged" },
        totalMinutes: { magnitude: 0, trend: "unchanged" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Distance not recorded" },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Elevation gain not recorded" },
        },
      },
    });
    await expect(
      repository.getWeekList({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "cycling",
      }),
    ).resolves.toEqual([]);
  });

  it("bounds historical overview periods to equal-length half-open windows", async () => {
    const repository = new ActivitiesCalendarRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      FULL_ACCESS_WINDOW,
    );

    await expect(
      repository.getActivityOverview({ weeks: 1, endDate: "2026-03-15" }),
    ).resolves.toMatchObject({
      activityCount: 3,
      totalMinutes: 75,
      activityTypes: ["running"],
      comparison: {
        periodLabel: "previous 1 week",
        activityCount: { magnitude: 2, trend: "higher" },
        totalMinutes: { magnitude: 60, trend: "higher" },
      },
    });
  });

  it("interprets access-window boundaries in the user's timezone", async () => {
    const repository = new ActivityRepository(
      testContext.db,
      BOUNDARY_USER_ID,
      "America/Los_Angeles",
      ACCESS_WINDOW,
      sensorStore,
    );

    await expect(
      repository.resolveVisibleActivityIds([BEFORE_LOCAL_ACCESS_ID, BEFORE_LOCAL_END_ID]),
    ).resolves.toEqual(new Set([BEFORE_LOCAL_END_ID]));
    const visibleIds = await repository.listVisibleActivityIdsSince("2026-03-01");
    expect(visibleIds).toContain(BEFORE_LOCAL_END_ID);
    expect(visibleIds).not.toContain(BEFORE_LOCAL_ACCESS_ID);
  });

  it("backfills legacy unavailable zeros within an explicit range without changing measured zero", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_location_summary_rows
SELECT * REPLACE(
  CAST(0, 'Nullable(Float64)') AS total_distance,
  CAST(12.34, 'Nullable(Float64)') AS centroid_lat,
  CAST(56.78, 'Nullable(Float64)') AS centroid_lng,
  refresh_version + 1 AS refresh_version,
  now64(9, 'UTC') AS refreshed_at
)
FROM analytics.activity_location_summary_rows FINAL
WHERE activity_id = '${AUTHORIZED_WALK_ID}'`,
    );
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_sensor_summary_rows
SELECT * REPLACE(
  CAST(0, 'Nullable(Float64)') AS elevation_gain_m,
  CAST(42, 'Nullable(UInt64)') AS sample_count,
  refresh_version + 1 AS refresh_version,
  now64(9, 'UTC') AS refreshed_at
)
FROM analytics.activity_sensor_summary_rows FINAL
WHERE activity_id = '${AUTHORIZED_WALK_ID}'`,
    );
    await executeClickHouseTestCommand(testContext, "TRUNCATE TABLE analytics.activity_summary");
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_summary (
        activity_id,
        user_id,
        canonical_type,
        name,
        started_at,
        ended_at,
        avg_hr,
        max_hr,
        min_hr,
        avg_power,
        max_power,
        avg_speed,
        max_speed,
        avg_cadence,
        elevation_gain_legacy,
        total_distance,
        centroid_lat,
        centroid_lng,
        avg_left_balance,
        avg_left_torque_eff,
        avg_right_torque_eff,
        avg_left_pedal_smooth,
        avg_right_pedal_smooth,
        elevation_gain_m,
        elevation_loss_m,
        avg_stance_time,
        avg_vertical_osc,
        avg_ground_contact_time,
        avg_stride_length,
        sample_count,
        hr_sample_count,
        power_sample_count,
        first_sample_at,
        last_sample_at,
        best_twenty_minute_power,
        normalized_power,
        smoothed_avg_power,
        climbing_elevation_gain_m,
        climbing_seconds,
        refreshed_at
      ) VALUES (
        toUUID('${AUTHORIZED_WALK_ID}'),
        toUUID('${TEST_USER_ID}'),
        'walking',
        'Authorized Walk',
        toDateTime64('2026-03-16 10:00:00', 6, 'UTC'),
        toDateTime64('2026-03-16 10:30:00', 6, 'UTC'),
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        CAST(0, 'Nullable(Float64)'),
        CAST(0, 'Nullable(Float64)'),
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        CAST(0, 'Nullable(Float64)'),
        CAST(0, 'Nullable(Float64)'),
        NULL,
        NULL,
        NULL,
        NULL,
        0,
        0,
        0,
        toDateTime64('2026-03-16 10:00:00', 6, 'UTC'),
        toDateTime64('2026-03-16 10:30:00', 6, 'UTC'),
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        now64(9, 'UTC')
      )`,
    );

    const repository = new ActivitiesCalendarRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      ACCESS_WINDOW,
    );
    await expect(
      repository.getActivityOverview({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "walking",
      }),
    ).resolves.toMatchObject({
      totalDistanceMeters: 0,
      totalElevationGainM: 0,
    });

    const client = getClickHouseTestClient(testContext);
    await expect(
      backfillActivityOverviewAvailability(client, {
        start: new Date("2026-03-15T10:00:00Z"),
        end: new Date("2026-03-16T10:00:00Z"),
        execute: false,
      }),
    ).resolves.toEqual({ distanceRows: 0, elevationRows: 0 });
    await expect(
      backfillActivityOverviewAvailability(client, {
        start: new Date("2026-03-16T10:00:00Z"),
        end: new Date("2026-03-17T10:00:00Z"),
        execute: false,
      }),
    ).resolves.toEqual({ distanceRows: 1, elevationRows: 1 });

    await expect(
      repository.getActivityOverview({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "walking",
      }),
    ).resolves.toMatchObject({
      totalDistanceMeters: 0,
      totalElevationGainM: 0,
    });

    const range = {
      start: new Date("2026-03-14T00:00:00Z"),
      end: new Date("2026-03-17T10:00:00Z"),
      execute: true,
    };
    await expect(backfillActivityOverviewAvailability(client, range)).resolves.toEqual({
      distanceRows: 1,
      elevationRows: 1,
    });
    await executeClickHouseTestCommand(
      testContext,
      "REBUILD TEST ANALYTICS TABLE analytics.activity_summary",
    );
    await expect(backfillActivityOverviewAvailability(client, range)).resolves.toEqual({
      distanceRows: 0,
      elevationRows: 0,
    });

    await expect(
      repository.getActivityOverview({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "walking",
      }),
    ).resolves.toMatchObject({
      totalDistanceMeters: null,
      totalElevationGainM: null,
    });
    const preservedFieldsResult = await client.query({
      query: `SELECT
  location.centroid_lat AS centroid_lat,
  location.centroid_lng AS centroid_lng,
  sensor.sample_count AS sample_count
FROM analytics.activity_location_summary_rows AS location FINAL
INNER JOIN analytics.activity_sensor_summary_rows AS sensor FINAL
  ON sensor.activity_id = location.activity_id
 AND sensor.user_id = location.user_id
WHERE location.activity_id = '${AUTHORIZED_WALK_ID}'`,
      format: "JSONEachRow",
    });
    expect(preservedBackfillFieldsSchema.parse(await preservedFieldsResult.json())).toEqual([
      {
        centroid_lat: 12.34,
        centroid_lng: 56.78,
        sample_count: 42,
      },
    ]);
    await expect(
      repository.getActivityOverview({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "running",
      }),
    ).resolves.toMatchObject({
      totalDistanceMeters: 0,
      totalElevationGainM: 0,
    });
  });
});
