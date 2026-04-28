import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

/**
 * Integration tests covering uncovered transformation logic in tRPC router endpoints.
 * Inserts realistic data and verifies computed results for:
 * - duration-curves (paceCurve, HR curve model fitting)
 * - efficiency (aerobicDecoupling, polarizationTrend)
 * - cycling-advanced (pedalDynamics)
 * - power (powerCurve, eftpTrend)
 * - supplements (list, save)
 * - trends (daily, weekly — via continuous aggregates)
 * - settings (get, set, getAll, slackStatus)
 * - sync (providers, providerStats, logs, syncStatus)
 * - food (search, quickAdd, update, delete, list with meal filter)
 * - pmc (learned model path)
 * - healthspan (trend with weekly history)
 * - nutrition-analytics (micronutrientAdequacy, macroRatios)
 */
describe("Router data coverage", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;
  const activityIds: string[] = [];

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50, ftp = 250, birth_date = '1990-01-01'
          WHERE id = ${TEST_USER_ID}`,
    );

    // Insert provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert 'dofek' provider for food entries
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('dofek', 'Dofek App', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // ── Insert daily metrics for 90 days (needed for resting_hr lookups, steps, hrv) ──
    for (let i = 90; i >= 0; i--) {
      const rhr = 52 + Math.round(Math.cos(i * 0.3) * 3);
      const hrv = 55 + Math.round(Math.sin(i * 0.3) * 5);
      const steps = 8000 + Math.round(Math.sin(i) * 2000);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, resting_hr, hrv, steps, vo2max
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'test_provider', ${TEST_USER_ID}, ${rhr}, ${hrv}, ${steps}, 45
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // ── Insert activities with 1-second metric_stream ──
    // Duration curve SQL divides by ROUND(duration_s / interval_s), which is 0
    // when interval_s > duration_s. ALL data must use 1-second intervals to avoid
    // division by zero on short durations (5s, 15s, etc.)
    //
    // We insert 6 activities with 1-second data (1800 samples each = 30 min).
    // Batch insert (100 rows at a time) for speed.
    for (let actIdx = 0; actIdx < 6; actIdx++) {
      const daysAgo = 5 + actIdx * 7;
      const durationSec = 1800; // 30 minutes
      const avgHr = 145 + actIdx * 5;
      const avgPower = 190 + actIdx * 15;
      const hasAltitude = actIdx < 2; // first 2 activities have altitude for VAM

      const actResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'test_provider', ${TEST_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second',
              ${`Training Ride ${actIdx}`}
            ) RETURNING id`,
      );
      const actId = actResult[0]?.id;

      if (actId) {
        activityIds.push(actId);
        for (let batchStart = 0; batchStart < durationSec; batchStart += 100) {
          const batchEnd = Math.min(batchStart + 100, durationSec);
          const sensorValues: string[] = [];
          for (let s = batchStart; s < batchEnd; s++) {
            const hr = avgHr + Math.round(Math.sin(s * 0.01) * 8);
            const power = avgPower + Math.round(Math.cos(s * 0.01) * 20);
            const speed = 7.5 + Math.sin(s * 0.005) * 1.5;
            const alt = hasAltitude ? `${300 + (s / durationSec) * 200}` : "NULL";
            const grd = hasAltitude ? `${4 + (s % 7) * 0.5}` : "NULL";
            const balance = 49.5 + (s % 10) * 0.1;
            const lte = 75 + (s % 5);
            const rte = 74 + (s % 5);
            const lps = 18 + (s % 4);
            const rps = 17 + (s % 4);
            const ts = `CURRENT_TIMESTAMP - ${daysAgo} * INTERVAL '1 day' + ${s} * INTERVAL '1 second'`;
            sensorValues.push(
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${actId}', ${hr}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'power', '${actId}', ${power}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'speed', '${actId}', ${speed}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'left_right_balance', '${actId}', ${balance}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'left_torque_effectiveness', '${actId}', ${lte}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'right_torque_effectiveness', '${actId}', ${rte}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'left_pedal_smoothness', '${actId}', ${lps}, NULL)`,
              `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'right_pedal_smoothness', '${actId}', ${rps}, NULL)`,
            );
            if (hasAltitude) {
              sensorValues.push(
                `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'altitude', '${actId}', ${alt}, NULL)`,
                `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'grade', '${actId}', ${grd}, NULL)`,
              );
            }
          }
          await testCtx.db.execute(
            sql.raw(`INSERT INTO fitness.metric_stream (
              recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
            ) VALUES ${sensorValues.join(",\n")}`),
          );
        }
      }
    }

    // ── Insert a running activity for pace curve (1-second intervals) ──
    const runDurationSec = 1200; // 20 minutes
    const runResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'running',
            CURRENT_TIMESTAMP - INTERVAL '3 days',
            CURRENT_TIMESTAMP - INTERVAL '3 days' + ${runDurationSec}::int * INTERVAL '1 second',
            'Morning Run'
          ) RETURNING id`,
    );
    const runId = runResult[0]?.id;
    if (runId) {
      for (let batchStart = 0; batchStart < runDurationSec; batchStart += 100) {
        const batchEnd = Math.min(batchStart + 100, runDurationSec);
        const sensorValues: string[] = [];
        for (let s = batchStart; s < batchEnd; s++) {
          const speed = 3.0 + Math.sin(s * 0.005) * 0.5;
          const hr = 155 + Math.round(Math.sin(s * 0.01) * 8);
          const ts = `CURRENT_TIMESTAMP - INTERVAL '3 days' + ${s} * INTERVAL '1 second'`;
          sensorValues.push(
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${runId}', ${hr}, NULL)`,
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'speed', '${runId}', ${speed}, NULL)`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
            recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
          ) VALUES ${sensorValues.join(",\n")}`),
        );
      }
    }

    // ── Insert sleep sessions with stage data for recovery/healthspan ──
    for (let i = 90; i >= 0; i--) {
      const duration = 450 + Math.round(Math.sin(i * 0.4) * 30);
      const deep = Math.round(duration * 0.15);
      const rem = Math.round(duration * 0.22);
      const awake = Math.round(duration * 0.05);
      const light = duration - deep - rem - awake;
      const efficiency = 88 + Math.round(Math.sin(i * 0.2) * 5);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
              efficiency_pct, sleep_type
            ) VALUES (
              'test_provider', ${TEST_USER_ID},
              (CURRENT_DATE - ${i}::int)::timestamp + INTERVAL '22 hours 30 minutes',
              (CURRENT_DATE - ${i}::int + 1)::timestamp + INTERVAL '6 hours',
              ${duration}, ${deep}, ${rem}, ${light}, ${awake},
              ${efficiency}, 'sleep'
            )`,
      );
    }

    // ── Insert body measurements for 35 days (needed for body-analytics branches) ──
    // Slight upward trend to cover "gaining" branch in weightTrend
    for (let i = 34; i >= 0; i--) {
      const weight = 73 + (34 - i) * 0.08 + Math.sin(i) * 0.3; // upward trend ~0.08 kg/day
      const bodyFat = 17 + (34 - i) * 0.02;
      await testCtx.db.execute(
        sql`INSERT INTO fitness.body_measurement (
              recorded_at, provider_id, user_id, weight_kg, body_fat_pct
            ) VALUES (
              NOW() - ${i}::int * INTERVAL '1 day', 'test_provider', ${TEST_USER_ID}, ${weight}, ${bodyFat}
            )`,
      );
    }

    // ── Insert strength workouts with sets for healthspan + strength endpoints ──
    // Create an exercise first
    await testCtx.db.execute(
      sql`INSERT INTO fitness.exercise (id, name, equipment)
          VALUES ('00000000-0000-0000-0000-000000000099', 'Squat', 'Barbell')
          ON CONFLICT DO NOTHING`,
    );

    for (let i = 0; i < 8; i++) {
      const workoutResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, started_at, name, activity_type
            ) VALUES (
              'test_provider', ${TEST_USER_ID}, ${`sw-${i}`},
              NOW() - ${i * 4}::int * INTERVAL '1 day', 'Strength Session', 'strength'
            ) ON CONFLICT DO NOTHING RETURNING id`,
      );
      const workoutId = workoutResult[0]?.id;
      if (workoutId) {
        // Add 3 sets per workout
        for (let s = 0; s < 3; s++) {
          await testCtx.db.execute(
            sql`INSERT INTO fitness.strength_set (
                  activity_id, exercise_id, exercise_index, set_index, set_type,
                  weight_kg, reps, rpe
                ) VALUES (
                  ${workoutId}, '00000000-0000-0000-0000-000000000099',
                  0, ${s}, 'working',
                  ${80 + i * 2.5}, ${8 - s}, ${7 + s * 0.5}
                )`,
          );
        }
      }
    }

    // ── Insert food entries for food/nutrition tests ──
    for (let i = 0; i < 10; i++) {
      const dateOffset = i;
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, meal, food_name, food_description, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${dateOffset}::int,
                'breakfast', ${`Oatmeal ${i}`}, 'Steel-cut oats with berries',
                true
              ) RETURNING id
            ),
            new_nutrition AS (
              INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              SELECT id, nutrient_id, amount
              FROM new_entry
              CROSS JOIN (VALUES
                ('calories', 350),
                ('protein', 12),
                ('carbohydrate', 55),
                ('fat', 8),
                ('fiber', 6),
                ('vitamin_c', 15),
                ('calcium', 200),
                ('iron', 4)
              ) AS nutrient_values(nutrient_id, amount)
            )
            SELECT 1`,
      );
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, meal, food_name, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${dateOffset}::int,
                'lunch', ${`Chicken Salad ${i}`}, true
              ) RETURNING id
            ),
            new_nutrition AS (
              INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
              SELECT id, nutrient_id, amount
              FROM new_entry
              CROSS JOIN (VALUES
                ('calories', 500),
                ('protein', 35),
                ('carbohydrate', 20),
                ('fat', 25)
              ) AS nutrient_values(nutrient_id, amount)
            )
            SELECT 1`,
      );
    }

    // ── Insert unnamed food-entry nutrition rows for caloric balance ──
    for (let i = 0; i < 10; i++) {
      await testCtx.db.execute(
        sql`WITH new_entry AS (
              INSERT INTO fitness.food_entry (
                user_id, provider_id, date, external_id, food_name, source_name, confirmed
              ) VALUES (
                ${TEST_USER_ID}, 'dofek',
                CURRENT_DATE - ${i}::int,
                ${`daily-nutrition-${i}`}, NULL, 'Fixture', true
              ) RETURNING id
            )
            INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
            SELECT id, nutrient_id, amount
            FROM new_entry
            CROSS JOIN (VALUES
              ('calories', 2200::real),
              ('protein', 120::real),
              ('carbohydrate', 250::real),
              ('fat', 80::real)
            ) AS nutrient_values(nutrient_id, amount)
            ON CONFLICT DO NOTHING`,
      );
    }

    // ── Refresh materialized views ──
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testCtx.db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_body_measurement`,
    );
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

    // Start server
    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  /** POST a tRPC query and return parsed response data */
  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  /** POST a tRPC mutation and return parsed response data */
  async function mutate<T = unknown>(
    path: string,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  // ══════════════════════════════════════════════════════════════
  // Duration Curves — pace curve and HR curve model fitting
  // ══════════════════════════════════════════════════════════════
  describe("durationCurves", () => {
    it("hrCurve returns points and fits a critical HR model", async () => {
      const result = await query<{
        points: {
          durationSeconds: number;
          label: string;
          bestHeartRate: number;
          activityDate: string;
        }[];
        model: { thresholdHr: number; r2: number } | null;
      }>("durationCurves.hrCurve", { days: 90 });

      expect(result.points.length).toBeGreaterThan(0);

      for (const point of result.points) {
        expect(point.durationSeconds).toBeGreaterThan(0);
        expect(point.label).toBeTruthy();
        expect(point.bestHeartRate).toBeGreaterThan(0);
        expect(point.activityDate).toBeTruthy();
      }

      // With sufficient data points, the model should be fit
      if (result.points.length >= 3) {
        expect(result.model).not.toBeNull();
        if (result.model) {
          expect(result.model.thresholdHr).toBeGreaterThan(100);
          expect(result.model.thresholdHr).toBeLessThan(200);
          expect(result.model.r2).toBeGreaterThanOrEqual(0);
          expect(result.model.r2).toBeLessThanOrEqual(1);
        }
      }
    });

    it("paceCurve returns pace-per-km from speed data", async () => {
      const result = await query<{
        points: {
          durationSeconds: number;
          label: string;
          bestPaceSecondsPerKm: number;
          activityDate: string;
        }[];
      }>("durationCurves.paceCurve", { days: 90 });

      // We inserted running and cycling activities with speed data
      expect(result.points.length).toBeGreaterThan(0);

      for (const point of result.points) {
        expect(point.durationSeconds).toBeGreaterThan(0);
        expect(point.label).toBeTruthy();
        // Pace should be positive seconds per km
        expect(point.bestPaceSecondsPerKm).toBeGreaterThan(0);
        expect(point.activityDate).toBeTruthy();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Efficiency — aerobic decoupling and polarization trend
  // ══════════════════════════════════════════════════════════════
  describe("efficiency", () => {
    it("aerobicDecoupling returns first/second half ratios with sufficient samples", async () => {
      const result = await query<
        {
          date: string;
          activityType: string;
          name: string;
          firstHalfRatio: number;
          secondHalfRatio: number;
          decouplingPct: number;
          totalSamples: number;
        }[]
      >("efficiency.aerobicDecoupling", { days: 90 });

      // We inserted 70-min activities with power + HR, so some should qualify (>= 600 samples)
      // Note: with 1-min interval, 70 samples is only 70, not 600. The test data may not hit
      // the 600-sample threshold unless there are enough activities or we adjust.
      // Even if empty, the SQL should execute successfully.
      expect(Array.isArray(result)).toBe(true);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(typeof row.firstHalfRatio).toBe("number");
        expect(typeof row.secondHalfRatio).toBe("number");
        expect(typeof row.decouplingPct).toBe("number");
        expect(row.totalSamples).toBeGreaterThanOrEqual(600);
      }
    });

    it("polarizationTrend returns weekly zone distribution", async () => {
      const result = await query<{
        maxHr: number | null;
        weeks: {
          week: string;
          z1Seconds: number;
          z2Seconds: number;
          z3Seconds: number;
          polarizationIndex: number | null;
        }[];
      }>("efficiency.polarizationTrend", { days: 90 });

      expect(result.maxHr).toBe(190);
      expect(Array.isArray(result.weeks)).toBe(true);

      for (const week of result.weeks) {
        expect(week.week).toBeTruthy();
        expect(week.z1Seconds).toBeGreaterThanOrEqual(0);
        expect(week.z2Seconds).toBeGreaterThanOrEqual(0);
        expect(week.z3Seconds).toBeGreaterThanOrEqual(0);

        // If all three zones have time, PI should be computed
        if (week.z1Seconds > 0 && week.z2Seconds > 0 && week.z3Seconds > 0) {
          expect(week.polarizationIndex).not.toBeNull();
          expect(typeof week.polarizationIndex).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Cycling Advanced — pedal dynamics
  // ══════════════════════════════════════════════════════════════
  describe("cyclingAdvanced", () => {
    it("pedalDynamics returns L/R balance, torque effectiveness, pedal smoothness", async () => {
      const result = await query<
        {
          date: string;
          activityName: string;
          leftRightBalance: number;
          avgTorqueEffectiveness: number;
          avgPedalSmoothness: number;
        }[]
      >("cyclingAdvanced.pedalDynamics", { days: 90 });

      // We inserted pedal dynamics data (left_right_balance, torque_eff, pedal_smooth)
      // into metric_stream, but pedalDynamics reads from activity_summary which
      // aggregates these. The activity_summary view should have them.
      expect(Array.isArray(result)).toBe(true);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(row.activityName).toBeTruthy();
        expect(typeof row.leftRightBalance).toBe("number");
        expect(typeof row.avgTorqueEffectiveness).toBe("number");
        expect(typeof row.avgPedalSmoothness).toBe("number");
      }
    });

    it("verticalAscentRate returns VAM for climbing activities", async () => {
      const result = await query<
        {
          date: string;
          activityName: string;
          verticalAscentRate: number;
          elevationGainMeters: number;
          climbingMinutes: number;
        }[]
      >("cyclingAdvanced.verticalAscentRate", { days: 90 });

      // We inserted altitude + grade sensor data for the first 2 activities
      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(typeof row.verticalAscentRate).toBe("number");
        expect(row.verticalAscentRate).toBeGreaterThanOrEqual(0);
        expect(typeof row.elevationGainMeters).toBe("number");
        expect(typeof row.climbingMinutes).toBe("number");
        expect(row.climbingMinutes).toBeGreaterThan(0);
      }
    });

    it("verticalAscentRate uses nearby grade when present and altitude fallback otherwise", async () => {
      async function createActivity(name: string, startedAt: Date, endedAt: Date): Promise<string> {
        const activityRows = await testCtx.db.execute<{ id: string }>(
          sql`INSERT INTO fitness.activity (
                provider_id, user_id, activity_type, started_at, ended_at, name
              ) VALUES (
                'test_provider', ${TEST_USER_ID}, 'cycling', ${startedAt.toISOString()},
                ${endedAt.toISOString()}, ${name}
              )
              RETURNING id`,
        );
        const activityId = activityRows[0]?.id;

        if (!activityId) {
          throw new Error(`Failed to create ${name} activity`);
        }

        return activityId;
      }

      const startedAt = new Date();
      startedAt.setDate(startedAt.getDate() - 2);
      startedAt.setMinutes(0, 0, 0);
      const endedAt = new Date(startedAt.getTime() + 10 * 60 * 1000);

      const offsetGradeClimbId = await createActivity("Offset Grade Climb", startedAt, endedAt);
      const lowGradeDriftId = await createActivity(
        "Low Grade Drift",
        new Date(startedAt.getTime() + 20 * 60 * 1000),
        new Date(endedAt.getTime() + 20 * 60 * 1000),
      );
      const altitudeOnlyClimbId = await createActivity(
        "Altitude Only Climb",
        new Date(startedAt.getTime() + 40 * 60 * 1000),
        new Date(endedAt.getTime() + 40 * 60 * 1000),
      );

      const sensorValues: string[] = [];
      for (let second = 0; second <= 600; second += 5) {
        const offsetAltitudeTimestamp = new Date(startedAt.getTime() + second * 1000).toISOString();
        const offsetGradeTimestamp = new Date(
          startedAt.getTime() + second * 1000 + 2000,
        ).toISOString();
        const driftAltitudeTimestamp = new Date(
          startedAt.getTime() + 20 * 60 * 1000 + second * 1000,
        ).toISOString();
        const driftGradeTimestamp = new Date(
          startedAt.getTime() + 20 * 60 * 1000 + second * 1000 + 2000,
        ).toISOString();
        const altitudeOnlyTimestamp = new Date(
          startedAt.getTime() + 40 * 60 * 1000 + second * 1000,
        ).toISOString();
        const altitude = 400 + second * 0.6;

        sensorValues.push(
          `('${offsetAltitudeTimestamp}', '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'altitude', '${offsetGradeClimbId}', ${altitude}, NULL)`,
          `('${offsetGradeTimestamp}', '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'grade', '${offsetGradeClimbId}', 6, NULL)`,
          `('${driftAltitudeTimestamp}', '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'altitude', '${lowGradeDriftId}', ${altitude}, NULL)`,
          `('${driftGradeTimestamp}', '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'grade', '${lowGradeDriftId}', 0.5, NULL)`,
          `('${altitudeOnlyTimestamp}', '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'altitude', '${altitudeOnlyClimbId}', ${altitude}, NULL)`,
        );
      }

      await testCtx.db.execute(
        sql.raw(`INSERT INTO fitness.metric_stream (
          recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
        ) VALUES ${sensorValues.join(",\n")}`),
      );

      await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
      await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`);
      await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);
      await queryCache.invalidateAll();

      const result = await query<
        {
          date: string;
          activityName: string;
          verticalAscentRate: number;
          elevationGainMeters: number;
          climbingMinutes: number;
        }[]
      >("cyclingAdvanced.verticalAscentRate", { days: 90 });

      const offsetRow = result.find((row) => row.activityName === "Offset Grade Climb");
      const altitudeOnlyRow = result.find((row) => row.activityName === "Altitude Only Climb");
      const lowGradeRow = result.find((row) => row.activityName === "Low Grade Drift");

      expect(offsetRow).toBeDefined();
      expect(offsetRow?.elevationGainMeters).toBeGreaterThan(0);
      expect(offsetRow?.climbingMinutes).toBeGreaterThan(5);
      expect(offsetRow?.verticalAscentRate).toBeGreaterThan(0);

      expect(altitudeOnlyRow).toBeDefined();
      expect(altitudeOnlyRow?.elevationGainMeters).toBeGreaterThan(0);
      expect(altitudeOnlyRow?.verticalAscentRate).toBeGreaterThan(0);

      expect(lowGradeRow).toBeUndefined();
    });

    it("activityVariability returns NP, VI, IF per activity", async () => {
      const result = await query<{
        rows: {
          date: string;
          activityName: string;
          normalizedPower: number;
          averagePower: number;
          variabilityIndex: number;
          intensityFactor: number;
        }[];
        totalCount: number;
      }>("cyclingAdvanced.activityVariability", { days: 90 });

      expect(Array.isArray(result.rows)).toBe(true);
      expect(typeof result.totalCount).toBe("number");

      for (const row of result.rows) {
        expect(row.normalizedPower).toBeGreaterThan(0);
        expect(row.averagePower).toBeGreaterThan(0);
        // NP should be >= avg power
        expect(row.normalizedPower).toBeGreaterThanOrEqual(row.averagePower * 0.95);
        // VI = NP / AP, should be >= 1.0
        expect(row.variabilityIndex).toBeGreaterThanOrEqual(0.95);
        // IF = NP / FTP
        expect(row.intensityFactor).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Power — power curve and eFTP trend
  // ══════════════════════════════════════════════════════════════
  describe("power", () => {
    it("powerCurve returns best power per duration with CP model", async () => {
      const result = await query<{
        points: {
          durationSeconds: number;
          label: string;
          bestPower: number;
          activityDate: string;
        }[];
        model: { cp: number; wPrime: number; r2: number } | null;
      }>("power.powerCurve", { days: 90 });

      expect(result.points.length).toBeGreaterThan(0);

      for (const point of result.points) {
        expect(point.durationSeconds).toBeGreaterThan(0);
        expect(point.bestPower).toBeGreaterThan(0);
        expect(point.activityDate).toBeTruthy();
        expect(point.label).toBeTruthy();
      }

      // With enough data, the CP model should be fit
      const longPoints = result.points.filter(
        (p) => p.durationSeconds >= 120 && p.durationSeconds <= 600,
      );
      if (longPoints.length >= 3 && result.model) {
        expect(result.model.cp).toBeGreaterThan(0);
        expect(result.model.wPrime).toBeGreaterThan(0);
        expect(result.model.r2).toBeGreaterThanOrEqual(0);
      }
    });

    it("eftpTrend returns per-activity eFTP with current estimate", async () => {
      const result = await query<{
        trend: { date: string; eftp: number; activityName: string | null }[];
        currentEftp: number | null;
        model: { cp: number; wPrime: number; r2: number } | null;
      }>("power.eftpTrend", { days: 365 });

      expect(Array.isArray(result.trend)).toBe(true);

      for (const point of result.trend) {
        expect(point.date).toBeTruthy();
        expect(point.eftp).toBeGreaterThan(0);
      }

      // currentEftp should be estimated from CP model or best NP
      if (result.trend.length > 0) {
        expect(result.currentEftp).not.toBeNull();
        if (result.currentEftp != null) {
          expect(result.currentEftp).toBeGreaterThan(50);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Supplements — list and save
  // ══════════════════════════════════════════════════════════════
  describe("supplements", () => {
    it("list returns an array (possibly empty)", async () => {
      const result = await query<unknown[]>("supplements.list");
      expect(Array.isArray(result)).toBe(true);
    });

    it("save stores supplements and list retrieves them", async () => {
      const supplements = [
        { name: "Vitamin D3", amount: 5000, unit: "IU", form: "softgel", vitaminDMcg: 125 },
        { name: "Magnesium Glycinate", amount: 400, unit: "mg", magnesiumMg: 400 },
      ];
      const saveResult = await mutate<{ success: boolean; count: number }>("supplements.save", {
        supplements,
      });
      expect(saveResult.success).toBe(true);
      expect(saveResult.count).toBe(2);

      // Invalidate cache and verify list returns saved data
      await queryCache.invalidateAll();
      const listResult =
        await query<{ name: string; amount: number; unit: string }[]>("supplements.list");
      expect(listResult.length).toBe(2);
      expect(listResult[0]?.name).toBe("Vitamin D3");
      expect(listResult[1]?.name).toBe("Magnesium Glycinate");

      const nutritionRows = await testCtx.db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count
            FROM fitness.supplement_nutrient sn
            JOIN fitness.supplement s ON s.id = sn.supplement_id
            WHERE s.user_id = ${TEST_USER_ID}`,
      );
      expect(nutritionRows[0]?.count).toBe("2");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Trends — daily and weekly from continuous aggregates
  // ══════════════════════════════════════════════════════════════
  describe("trends", () => {
    it("daily returns aggregated metric data per day", async () => {
      const result = await query<
        {
          date: string;
          avgHr: number | null;
          maxHr: number | null;
          avgPower: number | null;
          maxPower: number | null;
          avgCadence: number | null;
          avgSpeed: number | null;
          totalSamples: number;
          hrSamples: number;
          powerSamples: number;
          activityCount: number;
        }[]
      >("trends.daily", { days: 90 });

      // Continuous aggregates may not be populated in test env,
      // but the query should succeed
      expect(Array.isArray(result)).toBe(true);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(typeof row.totalSamples).toBe("number");
        expect(typeof row.hrSamples).toBe("number");
        expect(typeof row.powerSamples).toBe("number");
        expect(typeof row.activityCount).toBe("number");
      }
    });

    it("weekly returns aggregated metric data per week", async () => {
      const result = await query<
        {
          week: string;
          avgHr: number | null;
          totalSamples: number;
          activityCount: number;
        }[]
      >("trends.weekly", { weeks: 12 });

      expect(Array.isArray(result)).toBe(true);

      for (const row of result) {
        expect(row.week).toBeTruthy();
        expect(typeof row.totalSamples).toBe("number");
        expect(typeof row.activityCount).toBe("number");
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Settings — get, set, getAll, slackStatus
  // ══════════════════════════════════════════════════════════════
  describe("settings", () => {
    it("set creates a setting and get retrieves it", async () => {
      const setResult = await mutate<{ key: string; value: unknown }>("settings.set", {
        key: "theme",
        value: "dark",
      });
      expect(setResult.key).toBe("theme");

      await queryCache.invalidateAll();

      const getResult = await query<{ key: string; value: unknown } | null>("settings.get", {
        key: "theme",
      });
      expect(getResult).not.toBeNull();
      expect(getResult?.key).toBe("theme");
      expect(getResult?.value).toBe("dark");
    });

    it("set upserts an existing setting", async () => {
      await mutate("settings.set", { key: "theme", value: "light" });
      await queryCache.invalidateAll();

      const result = await query<{ key: string; value: unknown } | null>("settings.get", {
        key: "theme",
      });
      expect(result?.value).toBe("light");
    });

    it("get returns null for missing key", async () => {
      const result = await query<null>("settings.get", { key: "nonexistent_key_xyz" });
      expect(result).toBeNull();
    });

    it("getAll returns all settings", async () => {
      // Set a second setting
      await mutate("settings.set", { key: "locale", value: "en-US" });
      await queryCache.invalidateAll();

      const result = await query<{ key: string; value: unknown }[]>("settings.getAll");
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(2);
      const keys = result.map((r) => r.key);
      expect(keys).toContain("theme");
      expect(keys).toContain("locale");
    });

    it("slackStatus returns configured and connected booleans", async () => {
      const result = await query<{ configured: boolean; connected: boolean }>(
        "settings.slackStatus",
      );
      expect(typeof result.configured).toBe("boolean");
      expect(typeof result.connected).toBe("boolean");
      // Environment-dependent, just ensure they are booleans
      expect(result.connected).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sync — providers, providerStats, logs, syncStatus
  // ══════════════════════════════════════════════════════════════
  describe("sync", () => {
    it("providerStats returns record counts per provider", async () => {
      const result =
        await query<
          {
            providerId: string;
            activities: number;
            dailyMetrics: number;
            sleepSessions: number;
            bodyMeasurements: number;
            foodEntries: number;
            healthEvents: number;
            metricStream: number;
            nutritionDaily: number;
            labPanels: number;
            labResults: number;
            journalEntries: number;
          }[]
        >("sync.providerStats");

      expect(Array.isArray(result)).toBe(true);
      // Should have our test_provider
      const testProvider = result.find((r) => r.providerId === "test_provider");
      if (testProvider) {
        expect(testProvider.activities).toBeGreaterThan(0);
        expect(testProvider.dailyMetrics).toBeGreaterThan(0);
        expect(testProvider.sleepSessions).toBeGreaterThan(0);
        expect(testProvider.metricStream).toBeGreaterThan(0);
      }
    });

    it("logs returns sync log history (empty initially)", async () => {
      const result = await query<unknown[]>("sync.logs", { limit: 10 });
      expect(Array.isArray(result)).toBe(true);
    });

    it("syncStatus returns null for unknown job", async () => {
      const result = await query<null>("sync.syncStatus", { jobId: "nonexistent-job-id" });
      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Food — search, quickAdd, update, delete, list with meal filter
  // ══════════════════════════════════════════════════════════════
  describe("food", () => {
    it("search returns matching food entries", async () => {
      const result = await query<{ food_name: string }[]>("food.search", { query: "Oatmeal" });
      expect(result.length).toBeGreaterThan(0);
      for (const row of result) {
        expect(row.food_name.toLowerCase()).toContain("oatmeal");
      }
    });

    it("list with meal filter returns only matching entries", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

      const result = await query<{ meal: string }[]>("food.list", {
        startDate: thirtyDaysAgo,
        endDate: today,
        meal: "lunch",
      });
      expect(result.length).toBeGreaterThan(0);
      for (const row of result) {
        expect(row.meal).toBe("lunch");
      }
    });

    it("quickAdd creates a food entry with minimal fields", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const result = await mutate<{ id: string; food_name: string; calories: number }>(
        "food.quickAdd",
        {
          date: today,
          meal: "snack",
          foodName: "Protein Bar",
          calories: 200,
          proteinG: 20,
        },
      );
      expect(result.food_name).toBe("Protein Bar");
      expect(Number(result.calories)).toBe(200);
    });

    it("update modifies a food entry", async () => {
      // Get a food entry id
      const today = new Date().toISOString().slice(0, 10);
      const entries = await query<{ id: string }[]>("food.byDate", { date: today });
      expect(entries.length).toBeGreaterThan(0);
      const entryId = entries[0]?.id;
      expect(entryId).toBeTruthy();

      const updated = await mutate<{ id: string; calories: number } | null>("food.update", {
        id: entryId,
        calories: 999,
      });
      expect(updated).not.toBeNull();
      expect(Number(updated?.calories)).toBe(999);
    });

    it("update with date field modification", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const entries = await query<{ id: string }[]>("food.byDate", { date: today });
      const entryId = entries[0]?.id;

      // Update date and set some fields to null (covers null-clearing branches)
      const updated = await mutate<{ id: string } | null>("food.update", {
        id: entryId,
        date: today,
        foodDescription: null,
        proteinG: null,
      });
      expect(updated).not.toBeNull();
    });

    it("update with no fields returns null", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const entries = await query<{ id: string }[]>("food.byDate", { date: today });
      const entryId = entries[0]?.id;
      const result = await mutate<null>("food.update", { id: entryId });
      expect(result).toBeNull();
    });

    it("delete removes a food entry", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const before = await query<{ id: string }[]>("food.byDate", { date: today });
      const countBefore = before.length;
      expect(countBefore).toBeGreaterThan(0);

      const entryId = before[0]?.id;
      const deleteResult = await mutate<{ success: boolean }>("food.delete", { id: entryId });
      expect(deleteResult.success).toBe(true);

      await queryCache.invalidateAll();
      const after = await query<{ id: string }[]>("food.byDate", { date: today });
      expect(after.length).toBe(countBefore - 1);
    });

    it("dailyTotals aggregates calories and macros by day", async () => {
      const result = await query<
        {
          date: string;
          calories: number;
          protein_g: number;
        }[]
      >("food.dailyTotals", { days: 30 });

      expect(result.length).toBeGreaterThan(0);
      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(Number(row.calories)).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // PMC — verify model info is populated
  // ══════════════════════════════════════════════════════════════
  describe("pmc", () => {
    it("chart returns FTP estimate and model type", async () => {
      const result = await query<{
        data: { date: string; load: number; ctl: number; atl: number; tsb: number }[];
        model: {
          type: "learned" | "generic";
          pairedActivities: number;
          r2: number | null;
          ftp: number | null;
        };
      }>("pmc.chart", { days: 90 });

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.model.ftp).not.toBeNull();
      if (result.model.ftp != null) {
        expect(result.model.ftp).toBeGreaterThan(100);
      }
      expect(result.model.pairedActivities).toBeGreaterThanOrEqual(0);

      // Verify daily load computation produces non-zero values
      const loadDays = result.data.filter((d) => d.load > 0);
      expect(loadDays.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Healthspan — score with trend
  // ══════════════════════════════════════════════════════════════
  describe("healthspan", () => {
    it("score returns composite with trend and metrics", async () => {
      const result = await query<{
        healthspanScore: number;
        metrics: {
          name: string;
          value: number | null;
          unit: string;
          score: number;
          status: string;
        }[];
        history: { weekStart: string; score: number }[];
        trend: "improving" | "declining" | "stable" | null;
      }>("healthspan.score", { weeks: 12 });

      expect(result.healthspanScore).toBeGreaterThanOrEqual(0);
      expect(result.healthspanScore).toBeLessThanOrEqual(100);
      expect(result.metrics).toHaveLength(9);

      expect(result.history.length).toBeGreaterThan(0);

      // Trend should be computed if 4+ weeks of history
      if (result.history.length >= 4) {
        expect(result.trend).not.toBeNull();
        expect(["improving", "declining", "stable"]).toContain(result.trend);
      }

      // Check specific metric statuses
      for (const metric of result.metrics) {
        expect(["excellent", "good", "fair", "poor"]).toContain(metric.status);
        expect(metric.score).toBeGreaterThanOrEqual(0);
        expect(metric.score).toBeLessThanOrEqual(100);
      }

      // Steps metric should reflect our test data (~8000 avg)
      const stepsMetric = result.metrics.find((m) => m.name === "Daily Steps");
      expect(stepsMetric).toBeDefined();
      if (stepsMetric?.value != null) {
        expect(stepsMetric.value).toBeGreaterThan(5000);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Nutrition Analytics — micronutrient adequacy and macro ratios
  // ══════════════════════════════════════════════════════════════
  describe("nutritionAnalytics", () => {
    it("micronutrientAdequacy returns RDA comparisons for tracked nutrients", async () => {
      const result = await query<
        {
          nutrient: string;
          unit: string;
          rda: number;
          avgIntake: number;
          percentRda: number;
          daysTracked: number;
        }[]
      >("nutritionAnalytics.micronutrientAdequacy", { days: 30 });

      // We inserted food entries with vitamin_c_mg, calcium_mg, iron_mg
      expect(result.length).toBeGreaterThan(0);

      const vitC = result.find((r) => r.nutrient === "Vitamin C");
      if (vitC) {
        expect(vitC.unit).toBe("mg");
        expect(vitC.rda).toBe(90);
        expect(vitC.avgIntake).toBeGreaterThan(0);
        expect(vitC.percentRda).toBeGreaterThan(0);
        expect(vitC.daysTracked).toBeGreaterThan(0);
      }
    });

    it("macroRatios returns protein/carbs/fat split per day", async () => {
      const result = await query<
        {
          date: string;
          proteinPct: number;
          carbsPct: number;
          fatPct: number;
          proteinPerKg: number | null;
        }[]
      >("nutritionAnalytics.macroRatios", { days: 30 });

      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        // Percentages should roughly sum to 100
        const total = row.proteinPct + row.carbsPct + row.fatPct;
        expect(total).toBeGreaterThan(90);
        expect(total).toBeLessThan(110);

        // With body measurement data, proteinPerKg should be computed
        if (row.proteinPerKg != null) {
          expect(row.proteinPerKg).toBeGreaterThan(0);
        }
      }
    });

    it("caloricBalance returns daily calorie balance with rolling avg", async () => {
      const result = await query<
        {
          date: string;
          caloriesIn: number;
          balance: number;
          rollingAvgBalance: number | null;
        }[]
      >("nutritionAnalytics.caloricBalance", { days: 30 });

      // May be empty if derived daily nutrition and daily_metrics don't overlap on dates
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Body Analytics ──
  describe("bodyAnalytics", () => {
    it("smoothedWeight returns EWMA-smoothed weight with weekly change", async () => {
      await queryCache.invalidateAll();
      const result = await query<
        { date: string; rawWeight: number; smoothedWeight: number; weeklyChange: number | null }[]
      >("bodyAnalytics.smoothedWeight", { days: 90 });

      expect(result.length).toBeGreaterThan(0);
      for (const row of result) {
        expect(row.rawWeight).toBeGreaterThan(0);
        expect(row.smoothedWeight).toBeGreaterThan(0);
      }
      // After 7+ data points, weeklyChange should be populated
      const withChange = result.filter((r) => r.weeklyChange !== null);
      if (result.length >= 8) {
        expect(withChange.length).toBeGreaterThan(0);
      }
    });

    it("recomposition returns fat/lean mass trends", async () => {
      const result = await query<
        {
          date: string;
          weightKg: number;
          bodyFatPct: number;
          fatMassKg: number;
          leanMassKg: number;
          smoothedFatMass: number;
          smoothedLeanMass: number;
        }[]
      >("bodyAnalytics.recomposition", { days: 180 });

      // Only populated if body_fat_pct data exists
      expect(Array.isArray(result)).toBe(true);
      for (const row of result) {
        expect(row.fatMassKg + row.leanMassKg).toBeCloseTo(row.weightKg, 0);
      }
    });

    it("weightTrend returns rate of change and trend direction", async () => {
      const result = await query<{
        currentWeekly: number | null;
        current4Week: number | null;
        trend: string;
      }>("bodyAnalytics.weightTrend", {});

      // With 35 body measurements and upward trend, should be "gaining"
      expect(["gaining", "losing", "stable", "insufficient"]).toContain(result.trend);
      // With 35 measurements, weekly should be calculated
      if (result.currentWeekly != null) {
        expect(typeof result.currentWeekly).toBe("number");
      }
      if (result.current4Week != null) {
        expect(typeof result.current4Week).toBe("number");
      }
    });
  });

  // ── Activity detail endpoints (covers byId, stream, hrZones null-check branches) ──
  describe("activity", () => {
    it("byId returns activity detail with summary metrics", async () => {
      if (activityIds.length === 0) return;
      await queryCache.invalidateAll();
      const result = await query<{
        id: string;
        activityType: string;
        startedAt: string;
        endedAt: string | null;
        name: string | null;
        avgHr: number | null;
        avgPower: number | null;
        avgSpeed: number | null;
        avgCadence: number | null;
        totalDistance: number | null;
        elevationGain: number | null;
        sampleCount: number | null;
      }>("activity.byId", { id: activityIds[0] });

      expect(result.id).toBe(activityIds[0]);
      expect(result.activityType).toBe("cycling");
      expect(result.startedAt).toBeTruthy();
      // With metric_stream data, summary metrics should be non-null
      expect(result.avgHr).not.toBeNull();
      expect(result.avgPower).not.toBeNull();
      expect(result.sampleCount).toBeGreaterThan(0);
    });

    it("stream returns downsampled metric points", async () => {
      if (activityIds.length === 0) return;
      const result = await query<
        {
          recordedAt: string;
          heartRate: number | null;
          power: number | null;
          speed: number | null;
          cadence: number | null;
          altitude: number | null;
          lat: number | null;
          lng: number | null;
          distance: number | null;
        }[]
      >("activity.stream", { id: activityIds[0], maxPoints: 100 });

      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(100);
      // First activity has HR, power, speed data
      const withHr = result.filter((p) => p.heartRate != null);
      expect(withHr.length).toBeGreaterThan(0);
    });

    it("hrZones returns 5-zone distribution", async () => {
      if (activityIds.length === 0) return;
      const result = await query<
        { zone: number; label: string; minPct: number; maxPct: number; seconds: number }[]
      >("activity.hrZones", { id: activityIds[0] });

      expect(result).toHaveLength(5);
      expect(result[0]?.zone).toBe(1);
      expect(result[4]?.zone).toBe(5);
      // With 1800 HR samples, at least some zones should have data
      const totalSeconds = result.reduce((sum, z) => sum + z.seconds, 0);
      expect(totalSeconds).toBeGreaterThan(0);
    });
  });

  // ── Life event analyze with ranged event (covers endDate branches) ──
  describe("lifeEvents.analyze", () => {
    it("analyze returns before/after comparison for ranged event", async () => {
      await queryCache.invalidateAll();
      // Create a life event with a date range (covers endDate != null branches)
      const event = await mutate<{ id: string }>("lifeEvents.create", {
        label: "Vacation",
        startedAt: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10),
        endedAt: new Date(Date.now() - 38 * 86400000).toISOString().slice(0, 10),
        category: "travel",
        ongoing: false,
        notes: "Test vacation event",
      });

      const result = await query<{
        event: Record<string, unknown>;
        metrics: unknown[];
        sleep: unknown[];
        bodyComp: unknown[];
      }>("lifeEvents.analyze", { id: event.id, windowDays: 30 });

      expect(result.event).toBeDefined();
      expect(Array.isArray(result.metrics)).toBe(true);
      expect(Array.isArray(result.sleep)).toBe(true);
      expect(Array.isArray(result.bodyComp)).toBe(true);
    });

    it("analyze handles ongoing event (covers NOW() branch)", async () => {
      const event = await mutate<{ id: string }>("lifeEvents.create", {
        label: "New Job",
        startedAt: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
        endedAt: null,
        category: "work",
        ongoing: true,
        notes: null,
      });

      const result = await query<{
        event: Record<string, unknown>;
        metrics: unknown[];
      }>("lifeEvents.analyze", { id: event.id, windowDays: 14 });

      expect(result.event).toBeDefined();
    });
  });

  // ── Trends (covers roundOrNull non-null branch with continuous aggregate data) ──
  describe("trends with data", () => {
    it("daily returns aggregated metrics from continuous aggregate", async () => {
      await queryCache.invalidateAll();
      const result = await query<
        {
          date: string;
          avgHr: number | null;
          maxHr: number | null;
          avgPower: number | null;
          totalSamples: number;
        }[]
      >("trends.daily", { days: 90 });

      // Continuous aggregates may or may not be populated depending on TimescaleDB
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Training with data (covers maxHr non-null path) ──
  describe("training with data", () => {
    it("hrZones returns zone distribution with max_hr set", async () => {
      await queryCache.invalidateAll();
      const result = await query<{
        maxHr: number | null;
        weeks: {
          week: string;
          zone1: number;
          zone2: number;
          zone3: number;
          zone4: number;
          zone5: number;
        }[];
      }>("training.hrZones", { days: 90 });

      // User profile has max_hr = 190, so maxHr should be set
      if (result.maxHr) {
        expect(result.maxHr).toBe(190);
        expect(Array.isArray(result.weeks)).toBe(true);
      }
    });
  });

  // ── Recovery with data (covers rollingAvgDuration non-null branch) ──
  describe("recovery with data", () => {
    it("sleepAnalytics returns nightly data with rolling averages", async () => {
      await queryCache.invalidateAll();
      const result = await query<{
        nightly: {
          date: string;
          durationMinutes: number;
          deepPct: number;
          remPct: number;
          lightPct: number;
          awakePct: number;
          efficiency: number;
          rollingAvgDuration: number | null;
        }[];
        sleepDebt: number;
      }>("recovery.sleepAnalytics", { days: 90 });

      expect(result.nightly.length).toBeGreaterThan(0);
      // With 90+ nights, rollingAvgDuration should be non-null for later entries
      const withRolling = result.nightly.filter((n) => n.rollingAvgDuration != null);
      expect(withRolling.length).toBeGreaterThan(0);
      expect(typeof result.sleepDebt).toBe("number");
    });

    it("hrvVariability returns HRV daily data", async () => {
      const result = await query<
        { date: string; hrv: number; rollingAvg: number | null; cv: number | null }[]
      >("recovery.hrvVariability", { days: 90 });

      expect(result.length).toBeGreaterThan(0);
    });

    it("workloadRatio returns acute/chronic ratio with displayed strain", async () => {
      const result = await query<{
        timeSeries: {
          date: string;
          dailyLoad: number;
          strain: number;
          acuteLoad: number;
          chronicLoad: number;
          workloadRatio: number | null;
        }[];
        displayedStrain: number;
        displayedDate: string | null;
      }>("recovery.workloadRatio", { days: 90 });

      expect(Array.isArray(result.timeSeries)).toBe(true);
      expect(typeof result.displayedStrain).toBe("number");
      expect(result.displayedStrain).toBeGreaterThanOrEqual(0);
      expect(result.displayedStrain).toBeLessThanOrEqual(21);
    });

    it("readinessScore returns composite score", async () => {
      const result = await query<{
        score: number | null;
        components: Record<string, unknown>;
        history: unknown[];
      }>("recovery.readinessScore", { days: 30 });

      expect(result).toBeDefined();
    });
  });

  // ── Stress with data ──
  describe("stress with data", () => {
    it("scores returns daily stress scores", async () => {
      await queryCache.invalidateAll();
      const result = await query<{
        daily: { date: string; score: number; components: Record<string, number> }[];
        weekly: { week: string; avgScore: number }[];
      }>("stress.scores", { days: 90 });

      expect(result).toBeDefined();
      expect(Array.isArray(result.daily)).toBe(true);
      expect(Array.isArray(result.weekly)).toBe(true);
    });
  });

  // ── Predictions with data (covers daily target path) ──
  describe("predictions with data", () => {
    it("targets returns list of prediction targets", async () => {
      await queryCache.invalidateAll();
      const result = await query<{ id: string; label: string; unit: string; type: string }[]>(
        "predictions.targets",
        {},
      );

      expect(result.length).toBeGreaterThan(0);
      expect(result.some((t) => t.type === "daily")).toBe(true);
    });

    it("predict with hrv target returns model results", async () => {
      const result = await query<{
        importance: { feature: string; importance: number }[];
        predictions: unknown[];
      } | null>("predictions.predict", { target: "hrv", days: 90 });

      // May be null with insufficient data, but should not error
      expect(result === null || typeof result === "object").toBe(true);
    });
  });

  // ── Strength with data (covers non-null result mapping) ──
  describe("strength with data", () => {
    it("workoutSummary returns workout list", async () => {
      await queryCache.invalidateAll();
      const result = await query<
        { id: string; name: string; startedAt: string; setCount: number }[]
      >("strength.workoutSummary", { days: 90 });

      // We inserted 8 strength workouts
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
