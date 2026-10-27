import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "./schema/core.ts";
import { backfillSleepQuality } from "./sleep-quality-backfill.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const sleepRowSchema = z.object({
  external_id: z.string(),
  staging_available: z.boolean(),
  deep_minutes: z.number().nullable(),
  rem_minutes: z.number().nullable(),
  light_minutes: z.number().nullable(),
  awake_minutes: z.number().nullable(),
  efficiency_pct: z.number().nullable(),
});

describe("backfillSleepQuality integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        ('apple_health', 'Apple Health', ${TEST_USER_ID}),
        ('garmin', 'Garmin', ${TEST_USER_ID}),
        ('eight_sleep', 'Eight Sleep', ${TEST_USER_ID})
      ON CONFLICT DO NOTHING
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.sleep_session (
        provider_id,
        user_id,
        external_id,
        started_at,
        ended_at,
        duration_minutes,
        deep_minutes,
        rem_minutes,
        light_minutes,
        awake_minutes,
        efficiency_pct
      )
      VALUES
        (
          'apple_health', ${TEST_USER_ID}, 'partial-apple',
          '2026-07-20T22:00:00Z', '2026-07-21T06:00:00Z',
          480, 0, 0, 0, 20, 0
        ),
        (
          'apple_health', ${TEST_USER_ID}, 'staged-apple',
          '2026-07-21T22:00:00Z', '2026-07-22T06:00:00Z',
          480, 90, 100, 250, 40, NULL
        ),
        (
          'apple_health', ${TEST_USER_ID}, 'partial-apple-null-stages',
          '2026-07-22T12:00:00Z', '2026-07-22T20:00:00Z',
          480, NULL, NULL, NULL, NULL, 0
        ),
        (
          'garmin', ${TEST_USER_ID}, 'partial-garmin',
          '2026-07-22T22:00:00Z', '2026-07-23T06:00:00Z',
          480, 0, 0, 0, 0, 90
        ),
        (
          'eight_sleep', ${TEST_USER_ID}, 'complete-eight',
          '2026-07-23T22:00:00Z', '2026-07-24T06:00:00Z',
          480, 90, 100, 250, 40, 91
        )
    `);
    await testContext.db.execute(sql`
      INSERT INTO fitness.sleep_stage (session_id, stage, started_at, ended_at)
      SELECT
        id,
        'deep'::fitness.sleep_stage_name,
        started_at + INTERVAL '1 hour',
        started_at + INTERVAL '2 hours'
      FROM fitness.sleep_session
      WHERE external_id = 'staged-apple'
      UNION ALL
      SELECT
        id,
        'awake'::fitness.sleep_stage_name,
        started_at + INTERVAL '6 hours',
        started_at + INTERVAL '6 hours 20 minutes'
      FROM fitness.sleep_session
      WHERE external_id = 'partial-apple'
      UNION ALL
      SELECT
        id,
        'rem'::fitness.sleep_stage_name,
        started_at + INTERVAL '2 hours',
        started_at + INTERVAL '3 hours'
      FROM fitness.sleep_session
      WHERE external_id = 'staged-apple'
    `);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("previews and idempotently applies conservative quality inference", async () => {
    const previewOptions = {
      execute: false,
      start: new Date("2026-07-01T00:00:00Z"),
      end: new Date("2026-08-01T00:00:00Z"),
    };

    await expect(backfillSleepQuality(testContext.db, previewOptions)).resolves.toEqual({
      rowsChanged: 5,
      stagingMarkedAvailable: 2,
      stageValuesCleared: 2,
      appleEfficiencyCleared: 2,
    });

    await expect(
      backfillSleepQuality(testContext.db, { ...previewOptions, execute: true }),
    ).resolves.toEqual({
      rowsChanged: 5,
      stagingMarkedAvailable: 2,
      stageValuesCleared: 2,
      appleEfficiencyCleared: 2,
    });
    await expect(
      backfillSleepQuality(testContext.db, { ...previewOptions, execute: true }),
    ).resolves.toEqual({
      rowsChanged: 0,
      stagingMarkedAvailable: 0,
      stageValuesCleared: 0,
      appleEfficiencyCleared: 0,
    });

    const rows = z.array(sleepRowSchema).parse(
      await testContext.db.execute(sql`
        SELECT
          external_id,
          staging_available,
          deep_minutes,
          rem_minutes,
          light_minutes,
          awake_minutes,
          efficiency_pct
        FROM fitness.sleep_session
        WHERE external_id IN (
          'partial-apple',
          'partial-apple-null-stages',
          'staged-apple',
          'partial-garmin',
          'complete-eight'
        )
        ORDER BY external_id
      `),
    );

    expect(rows).toEqual([
      {
        external_id: "complete-eight",
        staging_available: true,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 250,
        awake_minutes: 40,
        efficiency_pct: 91,
      },
      {
        external_id: "partial-apple",
        staging_available: false,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: 20,
        efficiency_pct: null,
      },
      {
        external_id: "partial-apple-null-stages",
        staging_available: false,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: null,
      },
      {
        external_id: "partial-garmin",
        staging_available: false,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        efficiency_pct: 90,
      },
      {
        external_id: "staged-apple",
        staging_available: true,
        deep_minutes: 90,
        rem_minutes: 100,
        light_minutes: 250,
        awake_minutes: 40,
        efficiency_pct: null,
      },
    ]);
  });
});
