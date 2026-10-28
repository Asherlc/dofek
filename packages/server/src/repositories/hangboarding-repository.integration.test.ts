import { randomUUID } from "node:crypto";
import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { HangboardingRepository } from "./hangboarding-repository.ts";

describe("HangboardingRepository integration", () => {
  const groupedActivityId = "2fd151b9-75fb-4ff8-98a4-c1881df78561";
  const otherUserId = "00000000-0000-0000-0000-000000000002";
  const analyticsDatabase = `hangboarding_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const sensorStore = new ClickHouseActivitySensorStore({
    query: (options) =>
      clickhouse.query({
        ...options,
        query: options.query.replaceAll("analytics.", `${analyticsDatabase}.`),
      }),
    command: (options) =>
      clickhouse.command({
        ...options,
        query: options.query.replaceAll("analytics.", `${analyticsDatabase}.`),
      }),
  });
  let testContext: TestContext;
  let firstActivityId: string;
  let nonHangboardingActivityId: string;
  let groupedOtherActivityId: string;
  let noHangTenActivityId: string;
  let firstDate: string;
  let secondDate: string;
  let noHangTenDate: string;
  let nullDataDate: string;
  let groupedDate: string;

  function dateOnly(timestamp: string): string {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    testContext = await setupTestDatabase();

    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('hangboarding-repository-test', 'Hang Ten', ${TEST_USER_ID}),
            ('hangboarding-repository-other', 'Other Hangboard', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES
            ('hangboarding-repository-test', 100),
            ('hangboarding-repository-other', 1)
          ON CONFLICT (provider_id) DO UPDATE SET priority = EXCLUDED.priority`,
    );

    const activities = await testContext.db.execute<{
      id: string;
      group_id: string;
      external_id: string;
      started_at: string;
    }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-session-1',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '2 days',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '10 minutes', 'Repeaters',
            '{"hangTen":{"sessionId":"session-1","planName":"Repeaters","boardId":"board-1","boardName":"Tension Board"}}'::jsonb
          ),
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-session-2',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '15 minutes', 'Max Hangs',
            '{"hangTen":{"sessionId":"session-2","planName":"Max Hangs","boardName":"Tension Board"}}'::jsonb
          ),
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-not-hangboard',
            'climbing', 'rock_climbing', CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '30 minutes', 'Wall Session', '{}'::jsonb
          ),
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-null-data',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '31 days', NULL,
            'Incomplete Session', '{"hangTen":{"sessionId":"session-null","planName":"Incomplete"}}'::jsonb
          ),
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-no-hang-ten',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '3 days',
            CURRENT_TIMESTAMP - INTERVAL '3 days' + INTERVAL '5 minutes', 'Metadata Missing', '{}'::jsonb
          )
          RETURNING id::text AS id, group_id::text AS group_id, external_id,
            started_at::text AS started_at`,
    );

    const firstActivity = activities.find(
      (activity) => activity.external_id === "hangboard-repository-session-1",
    );
    const nonHangboardingActivity = activities.find(
      (activity) => activity.external_id === "hangboard-repository-not-hangboard",
    );
    if (!firstActivity || !nonHangboardingActivity) {
      throw new Error("Failed to seed Hangboarding repository activities");
    }
    const secondActivity = activities.find(
      (activity) => activity.external_id === "hangboard-repository-session-2",
    );
    const nullDataActivity = activities.find(
      (activity) => activity.external_id === "hangboard-repository-null-data",
    );
    const noHangTenActivity = activities.find(
      (activity) => activity.external_id === "hangboard-repository-no-hang-ten",
    );
    if (!secondActivity || !nullDataActivity || !noHangTenActivity) {
      throw new Error("Failed to seed Hangboarding repository date fixtures");
    }
    firstDate = dateOnly(firstActivity.started_at);
    secondDate = dateOnly(secondActivity.started_at);
    nullDataDate = dateOnly(nullDataActivity.started_at);
    noHangTenDate = dateOnly(noHangTenActivity.started_at);
    firstActivityId = firstActivity.id;
    nonHangboardingActivityId = nonHangboardingActivity.id;
    noHangTenActivityId = noHangTenActivity.id;

    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_interval (
            activity_id, interval_index, label, interval_type, started_at, ended_at
          ) VALUES
          (${firstActivityId}::uuid, 0, 'Step 1: 19 mm edge', 'work',
            CURRENT_TIMESTAMP - INTERVAL '2 days', CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '7 seconds'),
          (${firstActivityId}::uuid, 1, 'Step 1: Rest', 'rest',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '7 seconds',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '60 seconds'),
          ((SELECT id FROM fitness.activity WHERE external_id = 'hangboard-repository-session-2'), 0,
            'Step 2: Work', 'work', CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '10 seconds'),
          ((SELECT id FROM fitness.activity WHERE external_id = 'hangboard-repository-session-2'), 1,
            'Step 2: Rest', 'rest', CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '10 seconds',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '60 seconds'),
          ((SELECT id FROM fitness.activity WHERE external_id = 'hangboard-repository-null-data'), 0,
            'Incomplete Work', 'work', CURRENT_TIMESTAMP - INTERVAL '31 days', NULL),
          ((SELECT id FROM fitness.activity WHERE external_id = 'hangboard-repository-null-data'), 1,
            'Incomplete Rest', 'rest', CURRENT_TIMESTAMP - INTERVAL '31 days', NULL)`,
    );

    const groupedActivities = await testContext.db.execute<{
      id: string;
      external_id: string;
      started_at: string;
    }>(
      sql`INSERT INTO fitness.activity (
            group_id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES
          (
            ${groupedActivityId}::uuid, 'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-grouped-hangten',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '40 days',
            CURRENT_TIMESTAMP - INTERVAL '40 days' + INTERVAL '10 minutes', 'Grouped Hang Ten',
            '{"hangTen":{"sessionId":"grouped-session","planName":"Grouped Hang Ten","boardName":"Tension Board"}}'::jsonb
          ),
          (
            ${groupedActivityId}::uuid, 'hangboarding-repository-other', ${TEST_USER_ID}, 'hangboard-repository-grouped-other',
            'hangboard', 'Other Hangboard', CURRENT_TIMESTAMP - INTERVAL '40 days',
            CURRENT_TIMESTAMP - INTERVAL '40 days' + INTERVAL '20 minutes', 'Grouped Other',
            '{"avgHeartRate":200,"maxHeartRate":210}'::jsonb
          )
          RETURNING id::text AS id, external_id, started_at::text AS started_at`,
    );
    const groupedOtherActivity = groupedActivities.find(
      (activity) => activity.external_id === "hangboard-repository-grouped-other",
    );
    const groupedHangTenActivity = groupedActivities.find(
      (activity) => activity.external_id === "hangboard-repository-grouped-hangten",
    );
    if (!groupedOtherActivity || !groupedHangTenActivity) {
      throw new Error("Failed to seed grouped Hangboarding activities");
    }
    groupedOtherActivityId = groupedOtherActivity.id;
    groupedDate = dateOnly(groupedOtherActivity.started_at);
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_interval (
            activity_id, interval_index, label, interval_type, started_at, ended_at
          ) VALUES
          (${groupedHangTenActivity.id}::uuid, 0, 'Hang Ten Work', 'work',
            CURRENT_TIMESTAMP - INTERVAL '40 days',
            CURRENT_TIMESTAMP - INTERVAL '40 days' + INTERVAL '7 seconds'),
          (${groupedOtherActivity.id}::uuid, 0, 'Other Work', 'work',
            CURRENT_TIMESTAMP - INTERVAL '40 days',
            CURRENT_TIMESTAMP - INTERVAL '40 days' + INTERVAL '999 seconds')`,
    );

    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${otherUserId}::uuid, 'Other Hangboarding User')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('hangboarding-other-user', 'Other User Hang Ten', ${otherUserId}::uuid)`,
    );
    const [otherUserActivity] = await testContext.db.execute<{ group_id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, raw
          ) VALUES (
            'hangboarding-other-user', ${otherUserId}::uuid, 'other-user-session',
            'hangboard', 'Hang Ten', CURRENT_TIMESTAMP - INTERVAL '1 day',
            CURRENT_TIMESTAMP - INTERVAL '1 day' + INTERVAL '10 minutes',
            '{"hangTen":{"planName":"Other User Session"}}'::jsonb
          ) RETURNING group_id::text AS group_id`,
    );
    if (!otherUserActivity) throw new Error("Failed to seed other user Hangboarding activity");

    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: buildTestAnalyticsTableStatement("analytics.activity_summary").replaceAll(
        "analytics.",
        `${analyticsDatabase}.`,
      ),
    });
    if (!clickhouse.insert) throw new Error("ClickHouse test client requires inserts");
    await clickhouse.insert({
      table: `${analyticsDatabase}.activity_summary`,
      format: "JSONEachRow",
      values: [
        { activity_id: firstActivity.group_id, user_id: TEST_USER_ID, avg_hr: 120, max_hr: 145 },
        { activity_id: secondActivity.group_id, user_id: TEST_USER_ID, avg_hr: 130, max_hr: 150 },
        { activity_id: groupedActivityId, user_id: TEST_USER_ID, avg_hr: 100, max_hr: 160 },
        { activity_id: groupedHangTenActivity.id, user_id: TEST_USER_ID, avg_hr: 400, max_hr: 410 },
        {
          activity_id: nonHangboardingActivity.group_id,
          user_id: TEST_USER_ID,
          avg_hr: 350,
          max_hr: 360,
        },
        {
          activity_id: otherUserActivity.group_id,
          user_id: otherUserId,
          avg_hr: 250,
          max_hr: 300,
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase} SYNC` });
    await clickhouse.close?.();
    await testContext?.cleanup();
  });

  it("reads a compact finger-loading summary from real Postgres rows", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);

    await expect(repository.getDetail(firstActivityId)).resolves.toMatchObject({
      planName: "Repeaters",
      boardName: "Tension Board",
      summary: {
        durationSeconds: 600,
        workIntervalCount: 1,
        totalWorkDurationSeconds: 7,
        totalRestDurationSeconds: 53,
        exercises: [{ label: "19 mm edge", workIntervalCount: 1, workDurationSeconds: 7 }],
      },
    });
  });

  it("returns the same details for a displayed group ID and a source member ID", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);
    const memberDetail = await repository.getDetail(groupedOtherActivityId);
    expect(memberDetail).not.toBeNull();
    await expect(repository.getDetail(groupedActivityId)).resolves.toEqual(memberDetail);
    await expect(
      new HangboardingRepository(testContext.db, otherUserId, "UTC", sensorStore).getDetail(
        groupedActivityId,
      ),
    ).resolves.toBeNull();
  });

  it("computes totals using canonical sensor heart rates when Hang Ten raw HR is absent", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);

    await expect(repository.getSummary(30)).resolves.toMatchObject({
      sessionCount: 3,
      totalDurationSeconds: 1800,
      averageDurationSeconds: 600,
      totalWorkDurationSeconds: 17,
      totalRestDurationSeconds: 103,
      workIntervalCount: 2,
      averageHeartRate: 125,
      peakHeartRate: 150,
      latestSession: expect.objectContaining({
        planName: "Max Hangs",
        boardName: "Tension Board",
        durationSeconds: 900,
      }),
      daily: [
        expect.objectContaining({ date: noHangTenDate, durationSeconds: 300 }),
        expect.objectContaining({ date: firstDate, durationSeconds: 600 }),
        expect.objectContaining({ date: secondDate, durationSeconds: 900 }),
      ],
    });
  });

  it("keeps canonical hangboard details visible when Hang Ten metadata is absent", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);

    await expect(repository.getDetail(noHangTenActivityId)).resolves.toEqual({
      planName: null,
      boardName: null,
      segmentsError: null,
      summary: {
        durationSeconds: 300,
        workIntervalCount: 0,
        totalWorkDurationSeconds: null,
        totalRestDurationSeconds: null,
        exercises: [],
      },
    });
  });

  it("reads sensor HR by group ID when another provider member is canonical", async () => {
    const nextDate = new Date(`${groupedDate}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const repository = new HangboardingRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: groupedDate,
        endDateExclusive: nextDate.toISOString().slice(0, 10),
      },
    );

    await expect(repository.getSummary(365)).resolves.toMatchObject({
      sessionCount: 1,
      totalDurationSeconds: 600,
      averageHeartRate: 100,
      peakHeartRate: 160,
    });
  });

  it("limits heart rates to the caller's accessible session dates", async () => {
    const repository = new HangboardingRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: firstDate,
        endDateExclusive: secondDate,
      },
    );

    await expect(repository.getSummary(30)).resolves.toMatchObject({
      sessionCount: 1,
      averageHeartRate: 120,
      peakHeartRate: 145,
    });
  });

  it("limits sensor heart rates to the caller's owned Hangboarding sessions", async () => {
    const repository = new HangboardingRepository(testContext.db, otherUserId, "UTC", sensorStore);

    await expect(repository.getSummary(30)).resolves.toMatchObject({
      sessionCount: 1,
      averageHeartRate: 250,
      peakHeartRate: 300,
    });
  });

  it("returns null summary metrics for a real session with unfinished intervals and no HR", async () => {
    const nextDate = new Date(`${nullDataDate}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const repository = new HangboardingRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: nullDataDate,
        endDateExclusive: nextDate.toISOString().slice(0, 10),
      },
    );

    await expect(repository.getSummary(365)).resolves.toMatchObject({
      sessionCount: 1,
      totalDurationSeconds: 0,
      averageDurationSeconds: null,
      totalWorkDurationSeconds: null,
      totalRestDurationSeconds: null,
      workIntervalCount: null,
      averageHeartRate: null,
      peakHeartRate: null,
      latestSession: expect.objectContaining({
        planName: "Incomplete",
        durationSeconds: 0,
      }),
      daily: [
        expect.objectContaining({
          date: nullDataDate,
          durationSeconds: 0,
          workDurationSeconds: null,
          restDurationSeconds: null,
        }),
      ],
    });
  });

  it("uses Hang Ten metadata and finger-loading data when another member is canonical", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);

    await expect(repository.getDetail(groupedOtherActivityId)).resolves.toMatchObject({
      planName: "Grouped Hang Ten",
      boardName: "Tension Board",
      summary: expect.objectContaining({
        durationSeconds: 600,
        workIntervalCount: 1,
        exercises: [expect.objectContaining({ label: "Hang Ten Work", workDurationSeconds: 7 })],
      }),
    });
  });

  it("rejects a non-owned activity and a non-Hangboarding activity", async () => {
    await expect(
      new HangboardingRepository(testContext.db, otherUserId, "UTC", sensorStore).getDetail(
        firstActivityId,
      ),
    ).resolves.toBeNull();
    await expect(
      new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore).getDetail(
        nonHangboardingActivityId,
      ),
    ).resolves.toBeNull();
  });
});
