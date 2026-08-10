import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { HangboardingRepository } from "./hangboarding-repository.ts";

describe("HangboardingRepository integration", () => {
  let testContext: TestContext;
  let firstActivityId: string;
  let nonHangboardingActivityId: string;

  beforeAll(async () => {
    testContext = await setupTestDatabase();

    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('hangboarding-repository-test', 'Hang Ten', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const activities = await testContext.db.execute<{ id: string; external_id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, raw
          ) VALUES
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-session-1',
            'hangboard', 'Hang Ten', '2026-08-07T14:00:00Z'::timestamptz,
            '2026-08-07T14:10:00Z'::timestamptz, 'Repeaters',
            '{"avgHeartRate":120,"maxHeartRate":145,"hangTen":{"sessionId":"session-1","planName":"Repeaters","boardId":"board-1","boardName":"Tension Board"}}'::jsonb
          ),
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-session-2',
            'hangboard', 'Hang Ten', '2026-08-08T14:00:00Z'::timestamptz,
            '2026-08-08T14:15:00Z'::timestamptz, 'Max Hangs',
            '{"avgHeartRate":130,"maxHeartRate":150,"hangTen":{"sessionId":"session-2","planName":"Max Hangs","boardName":"Tension Board"}}'::jsonb
          ),
          (
            'hangboarding-repository-test', ${TEST_USER_ID}, 'hangboard-repository-not-hangboard',
            'climbing', 'rock_climbing', '2026-08-08T16:00:00Z'::timestamptz,
            '2026-08-08T16:30:00Z'::timestamptz, 'Wall Session', '{}'::jsonb
          )
          RETURNING id::text AS id, external_id`,
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
    firstActivityId = firstActivity.id;
    nonHangboardingActivityId = nonHangboardingActivity.id;

    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_interval (
            activity_id, interval_index, label, interval_type, started_at, ended_at
          ) VALUES
          (${firstActivityId}::uuid, 0, 'Step 1: Work', 'work',
            '2026-08-07T14:00:00Z'::timestamptz, '2026-08-07T14:00:07Z'::timestamptz),
          (${firstActivityId}::uuid, 1, 'Step 1: Rest', 'rest',
            '2026-08-07T14:00:07Z'::timestamptz, '2026-08-07T14:01:00Z'::timestamptz),
          ((SELECT id FROM fitness.activity WHERE external_id = 'hangboard-repository-session-2'), 0,
            'Step 2: Work', 'work', '2026-08-08T14:00:00Z'::timestamptz,
            '2026-08-08T14:00:10Z'::timestamptz),
          ((SELECT id FROM fitness.activity WHERE external_id = 'hangboard-repository-session-2'), 1,
            'Step 2: Rest', 'rest', '2026-08-08T14:00:10Z'::timestamptz,
            '2026-08-08T14:01:00Z'::timestamptz)`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("reads detail metadata and ordered intervals from real Postgres rows", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC");

    await expect(repository.getDetail(firstActivityId)).resolves.toMatchObject({
      planName: "Repeaters",
      sessionId: "session-1",
      boardId: "board-1",
      boardName: "Tension Board",
      intervals: [
        expect.objectContaining({ intervalIndex: 0, intervalType: "work", durationSeconds: 7 }),
        expect.objectContaining({ intervalIndex: 1, intervalType: "rest", durationSeconds: 53 }),
      ],
    });
  });

  it("computes exact session, interval, heart-rate, latest-session, and daily totals", async () => {
    const repository = new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC");

    await expect(repository.getSummary(30)).resolves.toMatchObject({
      sessionCount: 2,
      totalDurationSeconds: 1500,
      averageDurationSeconds: 750,
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
        expect.objectContaining({ date: "2026-08-07", durationSeconds: 600 }),
        expect.objectContaining({ date: "2026-08-08", durationSeconds: 900 }),
      ],
    });
  });

  it("rejects a non-owned activity and a non-Hangboarding activity", async () => {
    await expect(
      new HangboardingRepository(
        testContext.db,
        "00000000-0000-0000-0000-000000000002",
        "UTC",
      ).getDetail(firstActivityId),
    ).resolves.toBeNull();
    await expect(
      new HangboardingRepository(testContext.db, TEST_USER_ID, "UTC").getDetail(
        nonHangboardingActivityId,
      ),
    ).resolves.toBeNull();
  });
});
