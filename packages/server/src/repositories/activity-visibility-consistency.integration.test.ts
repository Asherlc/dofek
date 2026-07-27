import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  createClickHouseTestActivitySensorStore,
  syncClickHouseTestActivitySensorStore,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { ActivitiesCalendarRepository } from "./activities-calendar-repository.ts";
import { ActivityRepository, type ActivitySensorStore } from "./activity-repository.ts";
import { TrainingRepository } from "./training-repository.ts";

const AUTHORIZED_RUN_ID = "11111111-1111-4111-8111-111111111111";
const AUTHORIZED_WALK_ID = "22222222-2222-4222-8222-222222222222";
const UNAUTHORIZED_RIDE_ID = "33333333-3333-4333-8333-333333333333";
const ACCESS_WINDOW: AccessWindow = {
  kind: "limited",
  paid: false,
  reason: "free_signup_week",
  startDate: "2026-03-10",
  endDateExclusive: "2026-03-17",
};

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
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, activity_type, started_at, ended_at, name
          ) VALUES
          (
            ${AUTHORIZED_RUN_ID}, 'issue_2060', ${TEST_USER_ID}, 'authorized-run', 'running',
            '2026-03-15T10:00:00Z', '2026-03-15T10:45:00Z', 'Authorized Run'
          ),
          (
            ${AUTHORIZED_WALK_ID}, 'issue_2060', ${TEST_USER_ID}, 'authorized-walk', 'walking',
            '2026-03-16T10:00:00Z', '2026-03-16T10:30:00Z', 'Authorized Walk'
          ),
          (
            ${UNAUTHORIZED_RIDE_ID}, 'issue_2060', ${TEST_USER_ID}, 'unauthorized-ride', 'cycling',
            '2026-02-15T10:00:00Z', '2026-02-15T11:30:00Z', 'Unauthorized Ride'
          )`,
    );
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    await syncClickHouseTestActivitySensorStore(testContext);
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
    const training = await trainingRepository.getActivityStatsAndWeeklyVolume(null);

    expect(calendar.flatMap((day) => day.activities.map((activity) => activity.id))).toEqual([
      AUTHORIZED_WALK_ID,
      AUTHORIZED_RUN_ID,
    ]);
    expect(overview).toEqual({
      activityCount: 2,
      totalMinutes: 75,
      totalDistanceMeters: 0,
      totalElevationGainM: 0,
      activityTypes: ["running", "walking"],
    });
    await expect(activityRepository.findById(AUTHORIZED_RUN_ID)).resolves.toMatchObject({
      id: AUTHORIZED_RUN_ID,
      name: "Authorized Run",
    });
    await expect(activityRepository.findById(UNAUTHORIZED_RIDE_ID)).resolves.toBeNull();
    expect(training.activities.map((activity) => activity.id).sort()).toEqual(
      [AUTHORIZED_RUN_ID, AUTHORIZED_WALK_ID].sort(),
    );
    expect(training.weeklyVolume).toEqual([
      expect.objectContaining({ activity_type: "running", count: 1 }),
      expect.objectContaining({ activity_type: "walking", count: 1 }),
    ]);
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
      totalDistanceMeters: 0,
      totalElevationGainM: 0,
      activityTypes: ["running", "walking"],
    });
    await expect(
      repository.getWeekList({
        weeks: 8,
        endDate: "2026-03-20",
        activityType: "cycling",
      }),
    ).resolves.toEqual([]);
  });
});
