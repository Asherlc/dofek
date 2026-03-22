import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { queryCache } from "../lib/cache.ts";

/**
 * Integration tests for router coverage gaps:
 * - stress (scores endpoint with JS scoring logic)
 * - predictions (targets + predict endpoints)
 * - recovery (sleepConsistency, hrvVariability, workloadRatio, sleepAnalytics, readinessScore)
 * - strength (volumeOverTime, estimatedOneRepMax, muscleGroupVolume, progressiveOverload, workoutSummary)
 * - anomalyDetection (check + history)
 * - power (eFTP fallback path)
 * - efficiency (aerobicDecoupling edge case)
 * - cyclingAdvanced (trainingMonotony)
 */
describe("Router coverage", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50, ftp = 250, birth_date = '1990-01-01'
          WHERE id = ${DEFAULT_USER_ID}`,
    );

    // Insert providers
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES ('dofek', 'Dofek App')
          ON CONFLICT DO NOTHING`,
    );

    // ── Daily metrics with HRV + resting HR for 90 days ──
    for (let i = 90; i >= 0; i--) {
      const rhr = 52 + Math.round(Math.cos(i * 0.3) * 3);
      const hrv = 55 + Math.round(Math.sin(i * 0.3) * 5);
      const steps = 8000 + Math.round(Math.sin(i) * 2000);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, resting_hr, hrv, steps, vo2max,
              active_energy_kcal, basal_energy_kcal
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'test_provider', ${DEFAULT_USER_ID}, ${rhr}, ${hrv}, ${steps}, 45,
              500, 1800
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // ── Sleep sessions for 90 days (with stage data for sleep analytics) ──
    for (let i = 90; i >= 0; i--) {
      const duration = 450 + Math.round(Math.sin(i * 0.4) * 30);
      const deep = Math.round(duration * 0.2);
      const rem = Math.round(duration * 0.22);
      const light = Math.round(duration * 0.45);
      const awake = duration - deep - rem - light;
      const efficiency = 85 + Math.round(Math.sin(i * 0.5) * 5);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'test_provider', ${DEFAULT_USER_ID},
              (CURRENT_DATE - ${i}::int)::timestamp + INTERVAL '22 hours 30 minutes',
              (CURRENT_DATE - ${i}::int + 1)::timestamp + INTERVAL '6 hours',
              ${duration}, ${deep}, ${rem}, ${light}, ${awake}, ${efficiency}, 'sleep'
            )`,
      );
    }

    // ── Cycling activities with metric_stream (1-second intervals) ──
    for (let actIdx = 0; actIdx < 6; actIdx++) {
      const daysAgo = 5 + actIdx * 7;
      const durationSec = 1800;
      const avgHr = 145 + actIdx * 5;
      const avgPower = 190 + actIdx * 15;

      const actResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'test_provider', ${DEFAULT_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second',
              ${`Training Ride ${actIdx}`}
            ) RETURNING id`,
      );
      const actId = actResult[0]?.id;

      if (actId) {
        for (let batchStart = 0; batchStart < durationSec; batchStart += 100) {
          const batchEnd = Math.min(batchStart + 100, durationSec);
          const values: string[] = [];
          for (let s = batchStart; s < batchEnd; s++) {
            const hr = avgHr + Math.round(Math.sin(s * 0.01) * 8);
            const power = avgPower + Math.round(Math.cos(s * 0.01) * 20);
            const speed = 7.5 + Math.sin(s * 0.005) * 1.5;
            values.push(
              `(CURRENT_TIMESTAMP - ${daysAgo} * INTERVAL '1 day' + ${s} * INTERVAL '1 second',
                '${DEFAULT_USER_ID}', '${actId}', 'test_provider',
                ${hr}, ${power}, ${speed})`,
            );
          }
          await testCtx.db.execute(
            sql.raw(`INSERT INTO fitness.metric_stream (
              recorded_at, user_id, activity_id, provider_id,
              heart_rate, power, speed
            ) VALUES ${values.join(",\n")}`),
          );
        }
      }
    }

    // ── Strength workouts with exercises and sets ──
    // Create exercises
    const exerciseResults = [];
    for (const [name, group] of [
      ["Bench Press", "chest"],
      ["Squat", "legs"],
      ["Deadlift", "back"],
    ]) {
      const result = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.exercise (name, muscle_group, equipment)
            VALUES (${name}, ${group}, 'barbell')
            ON CONFLICT (name, equipment) DO UPDATE SET muscle_group = EXCLUDED.muscle_group
            RETURNING id`,
      );
      exerciseResults.push({
        id: result[0]?.id,
        name,
      });
    }

    // Create strength workouts over several weeks
    for (let weekIdx = 0; weekIdx < 6; weekIdx++) {
      for (let dayIdx = 0; dayIdx < 2; dayIdx++) {
        const daysAgo = weekIdx * 7 + dayIdx * 3 + 1;
        const workoutResult = await testCtx.db.execute<{ id: string }>(
          sql`INSERT INTO fitness.strength_workout (
                provider_id, user_id, external_id, started_at, ended_at, name
              ) VALUES (
                'test_provider', ${DEFAULT_USER_ID},
                ${`sw-cov-${weekIdx}-${dayIdx}`},
                NOW() - ${daysAgo}::int * INTERVAL '1 day',
                NOW() - ${daysAgo}::int * INTERVAL '1 day' + INTERVAL '1 hour',
                'Full Body Workout'
              ) ON CONFLICT DO NOTHING
              RETURNING id`,
        );
        const workoutId = workoutResult[0]?.id;
        if (!workoutId) continue;

        // Insert sets for each exercise
        let exerciseIndex = 0;
        for (const ex of exerciseResults) {
          if (!ex.id) continue;
          for (let setIdx = 0; setIdx < 4; setIdx++) {
            // Progressive overload: weight increases each week
            const baseWeight = ex.name === "Squat" ? 100 : ex.name === "Deadlift" ? 120 : 80;
            const weight = baseWeight + weekIdx * 2.5;
            const reps = 8 - Math.floor(weekIdx / 2); // reps decrease as weight goes up
            await testCtx.db.execute(
              sql`INSERT INTO fitness.strength_set (
                    workout_id, exercise_id, exercise_index, set_index,
                    set_type, weight_kg, reps
                  ) VALUES (
                    ${workoutId}::uuid, ${ex.id}::uuid, ${exerciseIndex}, ${setIdx},
                    'working', ${weight}, ${reps}
                  )`,
            );
          }
          exerciseIndex++;
        }
      }
    }

    // ── Nutrition data for predictions ──
    for (let i = 0; i < 30; i++) {
      await testCtx.db.execute(
        sql`INSERT INTO fitness.nutrition_daily (
              user_id, provider_id, date, calories, protein_g, carbs_g, fat_g
            ) VALUES (
              ${DEFAULT_USER_ID}, 'dofek',
              CURRENT_DATE - ${i}::int,
              2200, 120, 250, 80
            ) ON CONFLICT DO NOTHING`,
      );
    }

    // ── Body measurement ──
    await testCtx.db.execute(
      sql`INSERT INTO fitness.body_measurement (
            recorded_at, provider_id, user_id, weight_kg, body_fat_pct
          ) VALUES (
            NOW() - INTERVAL '1 day', 'test_provider', ${DEFAULT_USER_ID}, 75, 18
          )`,
    );

    // ── Food entries for nutrition analytics ──
    for (let i = 0; i < 10; i++) {
      await testCtx.db.execute(
        sql`WITH nd AS (
              INSERT INTO fitness.nutrition_data (
                calories, protein_g, carbs_g, fat_g, fiber_g,
                vitamin_c_mg, calcium_mg, iron_mg
              ) VALUES (
                350, 12, 55, 8, 6,
                15, 200, 4
              )
              RETURNING id
            )
            INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name,
              nutrition_data_id, confirmed
            ) VALUES (
              ${DEFAULT_USER_ID}, 'dofek',
              CURRENT_DATE - ${i}::int,
              'breakfast', ${`Oatmeal ${i}`},
              (SELECT id FROM nd), true
            )`,
      );
    }

    // ── Refresh materialized views ──
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);
    await testCtx.db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_body_measurement`,
    );
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

  // ══════════════════════════════════════════════════════════════
  // Stress — daily stress scores from HRV/RHR/sleep deviations
  // ══════════════════════════════════════════════════════════════
  describe("stress", () => {
    it("scores returns daily stress with weekly aggregation and trend", async () => {
      const result = await query<{
        daily: {
          date: string;
          stressScore: number;
          hrvDeviation: number | null;
          restingHrDeviation: number | null;
          sleepEfficiency: number | null;
        }[];
        weekly: {
          weekStart: string;
          cumulativeStress: number;
          avgDailyStress: number;
          highStressDays: number;
        }[];
        latestScore: number | null;
        trend: "improving" | "worsening" | "stable";
      }>("stress.scores", { days: 90 });

      // Should have daily entries
      expect(result.daily.length).toBeGreaterThan(0);

      for (const day of result.daily) {
        expect(day.date).toBeTruthy();
        // Stress score should be 0-3
        expect(day.stressScore).toBeGreaterThanOrEqual(0);
        expect(day.stressScore).toBeLessThanOrEqual(3);
        // HRV deviation should be computed (we have 60+ days of data for baseline)
        if (day.hrvDeviation != null) {
          expect(typeof day.hrvDeviation).toBe("number");
        }
        if (day.restingHrDeviation != null) {
          expect(typeof day.restingHrDeviation).toBe("number");
        }
      }

      // Weekly aggregation
      expect(result.weekly.length).toBeGreaterThan(0);
      for (const week of result.weekly) {
        expect(week.weekStart).toBeTruthy();
        expect(week.cumulativeStress).toBeGreaterThanOrEqual(0);
        // Max cumulative = 7 days * 3 = 21
        expect(week.cumulativeStress).toBeLessThanOrEqual(21);
        expect(week.avgDailyStress).toBeGreaterThanOrEqual(0);
        expect(week.highStressDays).toBeGreaterThanOrEqual(0);
      }

      // Latest score
      expect(result.latestScore).not.toBeNull();
      if (result.latestScore != null) {
        expect(result.latestScore).toBeGreaterThanOrEqual(0);
        expect(result.latestScore).toBeLessThanOrEqual(3);
      }

      // Trend should be computed with 14+ days
      expect(["improving", "worsening", "stable"]).toContain(result.trend);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Predictions — targets list and daily prediction
  // ══════════════════════════════════════════════════════════════
  describe("predictions", () => {
    it("targets returns available prediction targets", async () => {
      const result =
        await query<{ id: string; label: string; unit: string; type: string }[]>(
          "predictions.targets",
        );

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Should include daily targets like hrv
      const hrvTarget = result.find((t) => t.id === "hrv");
      expect(hrvTarget).toBeDefined();
      if (hrvTarget) {
        expect(hrvTarget.label).toBeTruthy();
        expect(hrvTarget.unit).toBeTruthy();
        expect(hrvTarget.type).toBe("daily");
      }
    });

    it("predict for hrv returns model or null with available data", async () => {
      const result = await query<{
        targetId: string;
        targetLabel: string;
        targetUnit: string;
        featureImportances: { name: string; treeImportance: number }[];
        predictions: { date: string; actual: number }[];
        diagnostics: Record<string, unknown>;
        tomorrowPrediction: { linear: number; tree: number } | null;
      } | null>("predictions.predict", { target: "hrv", days: 365 });

      // With our test data it may train a model or return null
      // Either way should not throw
      if (result != null) {
        expect(result.targetId).toBe("hrv");
        expect(Array.isArray(result.featureImportances)).toBe(true);
        expect(Array.isArray(result.predictions)).toBe(true);
      }
    });

    it("predict for unknown target returns null", async () => {
      const result = await query<null>("predictions.predict", {
        target: "nonexistent_target_xyz",
        days: 365,
      });
      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Recovery — sleep consistency, HRV variability, workload, readiness
  // ══════════════════════════════════════════════════════════════
  describe("recovery", () => {
    it("sleepConsistency returns bedtime/waketime variability with consistency score", async () => {
      const result = await query<
        {
          date: string;
          bedtimeHour: number;
          waketimeHour: number;
          rollingBedtimeStddev: number | null;
          rollingWaketimeStddev: number | null;
          consistencyScore: number | null;
        }[]
      >("recovery.sleepConsistency", { days: 90 });

      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(typeof row.bedtimeHour).toBe("number");
        expect(typeof row.waketimeHour).toBe("number");
      }

      // With 90 days of consistent sleep, some rows should have consistency scores
      const withScores = result.filter((r) => r.consistencyScore != null);
      expect(withScores.length).toBeGreaterThan(0);

      for (const row of withScores) {
        expect(row.consistencyScore).toBeGreaterThanOrEqual(0);
        expect(row.consistencyScore).toBeLessThanOrEqual(100);
        expect(row.rollingBedtimeStddev).not.toBeNull();
        expect(row.rollingWaketimeStddev).not.toBeNull();
      }
    });

    it("hrvVariability returns rolling coefficient of variation", async () => {
      const result = await query<
        {
          date: string;
          hrv: number | null;
          rollingCoefficientOfVariation: number | null;
          rollingMean: number | null;
        }[]
      >("recovery.hrvVariability", { days: 90 });

      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        if (row.hrv != null) {
          expect(row.hrv).toBeGreaterThan(0);
        }
      }

      // After 7 days, rolling CV should be computed
      const withCv = result.filter((r) => r.rollingCoefficientOfVariation != null);
      expect(withCv.length).toBeGreaterThan(0);

      for (const row of withCv) {
        expect(row.rollingCoefficientOfVariation).toBeGreaterThanOrEqual(0);
        expect(row.rollingMean).not.toBeNull();
        if (row.rollingMean != null) {
          expect(row.rollingMean).toBeGreaterThan(0);
        }
      }
    });

    it("workloadRatio returns acute:chronic workload ratio with displayed strain", async () => {
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
      expect(result.timeSeries.length).toBeGreaterThan(0);

      expect(typeof result.displayedStrain).toBe("number");
      expect(result.displayedStrain).toBeGreaterThanOrEqual(0);
      expect(result.displayedStrain).toBeLessThanOrEqual(21);

      for (const row of result.timeSeries) {
        expect(row.date).toBeTruthy();
        expect(typeof row.dailyLoad).toBe("number");
        expect(typeof row.strain).toBe("number");
        expect(row.strain).toBeGreaterThanOrEqual(0);
        expect(row.strain).toBeLessThanOrEqual(21);
        expect(typeof row.acuteLoad).toBe("number");
        expect(typeof row.chronicLoad).toBe("number");
        expect(row.dailyLoad).toBeGreaterThanOrEqual(0);
      }
    });

    it("sleepAnalytics returns nightly data with stage percentages and sleep debt", async () => {
      const result = await query<{
        nightly: {
          date: string;
          durationMinutes: number;
          sleepMinutes: number;
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

      for (const night of result.nightly) {
        expect(night.date).toBeTruthy();
        expect(night.durationMinutes).toBeGreaterThan(0);
        // For non-Apple Health providers, sleepMinutes should equal durationMinutes
        expect(night.sleepMinutes).toBe(night.durationMinutes);
        // Stage percentages should roughly sum to 100
        const totalPct = night.deepPct + night.remPct + night.lightPct + night.awakePct;
        expect(totalPct).toBeGreaterThan(90);
        expect(totalPct).toBeLessThan(110);
        expect(night.efficiency).toBeGreaterThan(0);
      }

      // Sleep debt is computed from last 14 nights vs 480min target
      expect(typeof result.sleepDebt).toBe("number");
    });

    it("sleepAnalytics computes sleepMinutes from stages for Apple Health", async () => {
      // Insert apple_health provider
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('apple_health', 'Apple Health', ${DEFAULT_USER_ID})
            ON CONFLICT DO NOTHING`,
      );

      // Insert an Apple Health sleep session where duration = in-bed time (480 min)
      // but stages sum to less (deep + rem + light = 390 min, awake = 90 min)
      const deep = 100;
      const rem = 110;
      const light = 180;
      const awake = 90;
      const inBedDuration = deep + rem + light + awake; // 480
      const expectedSleepMinutes = deep + rem + light; // 390

      // Use a future date so this is clearly the latest entry after all seeded data
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'apple_health', ${DEFAULT_USER_ID},
              CURRENT_TIMESTAMP + INTERVAL '1 day',
              CURRENT_TIMESTAMP + INTERVAL '1 day' + INTERVAL '8 hours',
              ${inBedDuration}, ${deep}, ${rem}, ${light}, ${awake}, 81, 'sleep'
            )`,
      );

      // Refresh materialized view so v_sleep picks up the new row
      await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);

      // Clear cache so the query hits the DB
      await queryCache.invalidateAll();

      const result = await query<{
        nightly: {
          date: string;
          durationMinutes: number;
          sleepMinutes: number;
        }[];
        sleepDebt: number;
      }>("recovery.sleepAnalytics", { days: 1 });

      // Find the Apple Health night (latest entry)
      const latest = result.nightly[result.nightly.length - 1];
      expect(latest).toBeDefined();
      expect(latest?.durationMinutes).toBe(inBedDuration);
      expect(latest?.sleepMinutes).toBe(expectedSleepMinutes);
    });

    it("readinessScore returns composite scores with component breakdown", async () => {
      const result = await query<
        {
          date: string;
          readinessScore: number;
          components: {
            hrvScore: number;
            restingHrScore: number;
            sleepScore: number;
            respiratoryRateScore: number;
          };
        }[]
      >("recovery.readinessScore", { days: 30 });

      expect(result.length).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(row.readinessScore).toBeGreaterThanOrEqual(0);
        expect(row.readinessScore).toBeLessThanOrEqual(100);

        // Component scores should each be 0-100
        expect(row.components.hrvScore).toBeGreaterThanOrEqual(0);
        expect(row.components.hrvScore).toBeLessThanOrEqual(100);
        expect(row.components.restingHrScore).toBeGreaterThanOrEqual(0);
        expect(row.components.restingHrScore).toBeLessThanOrEqual(100);
        expect(row.components.sleepScore).toBeGreaterThanOrEqual(0);
        expect(row.components.sleepScore).toBeLessThanOrEqual(100);
        expect(row.components.respiratoryRateScore).toBeGreaterThanOrEqual(0);
        expect(row.components.respiratoryRateScore).toBeLessThanOrEqual(100);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Strength — volume, e1RM, muscle groups, progressive overload, summaries
  // ══════════════════════════════════════════════════════════════
  describe("strength", () => {
    it("volumeOverTime returns weekly tonnage data", async () => {
      const result = await query<
        {
          week: string;
          totalVolumeKg: number;
          setCount: number;
          workoutCount: number;
        }[]
      >("strength.volumeOverTime", { days: 90 });

      expect(result.length).toBeGreaterThan(0);

      for (const week of result) {
        expect(week.week).toBeTruthy();
        expect(week.totalVolumeKg).toBeGreaterThan(0);
        expect(week.setCount).toBeGreaterThan(0);
        expect(week.workoutCount).toBeGreaterThan(0);
      }
    });

    it("estimatedOneRepMax returns e1RM history for qualified exercises", async () => {
      const result = await query<
        {
          exerciseName: string;
          history: {
            date: string;
            estimatedMax: number;
            actualWeight: number;
            actualReps: number;
          }[];
        }[]
      >("strength.estimatedOneRepMax", { days: 90 });

      // With 6 weeks * 2 workouts = 12 appearances, exercises should qualify (>= 3)
      expect(result.length).toBeGreaterThan(0);

      for (const exercise of result) {
        expect(exercise.exerciseName).toBeTruthy();
        expect(exercise.history.length).toBeGreaterThanOrEqual(3);

        for (const entry of exercise.history) {
          expect(entry.date).toBeTruthy();
          expect(entry.estimatedMax).toBeGreaterThan(0);
          expect(entry.actualWeight).toBeGreaterThan(0);
          expect(entry.actualReps).toBeGreaterThanOrEqual(1);
          expect(entry.actualReps).toBeLessThanOrEqual(12);
          // Epley formula: e1RM = weight * (1 + reps/30)
          // e1RM should be >= actualWeight
          expect(entry.estimatedMax).toBeGreaterThanOrEqual(entry.actualWeight);
        }
      }
    });

    it("muscleGroupVolume returns weekly sets per muscle group", async () => {
      const result = await query<
        {
          muscleGroup: string;
          weeklyData: { week: string; sets: number }[];
        }[]
      >("strength.muscleGroupVolume", { days: 90 });

      expect(result.length).toBeGreaterThan(0);

      const groups = result.map((r) => r.muscleGroup);
      expect(groups).toContain("chest");
      expect(groups).toContain("legs");
      expect(groups).toContain("back");

      for (const group of result) {
        expect(group.weeklyData.length).toBeGreaterThan(0);
        for (const week of group.weeklyData) {
          expect(week.week).toBeTruthy();
          expect(week.sets).toBeGreaterThan(0);
        }
      }
    });

    it("progressiveOverload returns slope and progression status", async () => {
      const result = await query<
        {
          exerciseName: string;
          weeklyVolumes: number[];
          slopeKgPerWeek: number;
          isProgressing: boolean;
        }[]
      >("strength.progressiveOverload", { days: 90 });

      // Need >= 2 weeks to compute slope
      expect(result.length).toBeGreaterThan(0);

      for (const exercise of result) {
        expect(exercise.exerciseName).toBeTruthy();
        expect(exercise.weeklyVolumes.length).toBeGreaterThanOrEqual(2);
        expect(typeof exercise.slopeKgPerWeek).toBe("number");
        expect(typeof exercise.isProgressing).toBe("boolean");
        // With progressive overload built in (weight increases by 2.5 each week),
        // volume should be increasing
        expect(exercise.isProgressing).toBe(true);
        expect(exercise.slopeKgPerWeek).toBeGreaterThan(0);
      }
    });

    it("workoutSummary returns recent workout details", async () => {
      const result = await query<
        {
          date: string;
          name: string;
          exerciseCount: number;
          totalSets: number;
          totalVolumeKg: number;
          durationMinutes: number;
        }[]
      >("strength.workoutSummary", { days: 90 });

      expect(result.length).toBeGreaterThan(0);

      for (const workout of result) {
        expect(workout.date).toBeTruthy();
        expect(workout.name).toBe("Full Body Workout");
        expect(workout.exerciseCount).toBe(3);
        // 3 exercises * 4 sets = 12 sets
        expect(workout.totalSets).toBe(12);
        expect(workout.totalVolumeKg).toBeGreaterThan(0);
        expect(workout.durationMinutes).toBe(60);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Anomaly Detection — check and history
  // ══════════════════════════════════════════════════════════════
  describe("anomalyDetection", () => {
    it("check returns anomaly check result for today", async () => {
      const result = await query<{
        anomalies: {
          date: string;
          metric: string;
          value: number;
          baselineMean: number;
          baselineStddev: number;
          zScore: number;
          severity: "warning" | "alert";
        }[];
        checkedMetrics: string[];
      }>("anomalyDetection.check", {});

      expect(Array.isArray(result.anomalies)).toBe(true);
      expect(Array.isArray(result.checkedMetrics)).toBe(true);

      // With 90+ days of data, metrics should be checked
      // (checkedMetrics may be empty if today's data is missing from the view)
      for (const anomaly of result.anomalies) {
        expect(anomaly.date).toBeTruthy();
        expect(anomaly.metric).toBeTruthy();
        expect(typeof anomaly.value).toBe("number");
        expect(typeof anomaly.baselineMean).toBe("number");
        expect(typeof anomaly.baselineStddev).toBe("number");
        expect(typeof anomaly.zScore).toBe("number");
        expect(["warning", "alert"]).toContain(anomaly.severity);
      }
    });

    it("history returns historical anomalies over a period", async () => {
      const result = await query<
        {
          date: string;
          metric: string;
          value: number;
          baselineMean: number;
          baselineStddev: number;
          zScore: number;
          severity: "warning" | "alert";
        }[]
      >("anomalyDetection.history", { days: 90 });

      expect(Array.isArray(result)).toBe(true);

      // With sinusoidal HRV/RHR data, some days may have outliers
      for (const anomaly of result) {
        expect(anomaly.date).toBeTruthy();
        expect(["Resting Heart Rate", "Heart Rate Variability"]).toContain(anomaly.metric);
        expect(typeof anomaly.value).toBe("number");
        expect(typeof anomaly.zScore).toBe("number");
        expect(["warning", "alert"]).toContain(anomaly.severity);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Power — eFTP trend (fallback path when CP model can't fit)
  // ══════════════════════════════════════════════════════════════
  describe("power eFTP fallback", () => {
    it("eftpTrend returns current eFTP from trend when CP model unavailable", async () => {
      // With limited data the CP model may or may not fit.
      // Either way, the endpoint should return a result.
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

      // currentEftp should be estimated from either CP model or best NP
      if (result.trend.length > 0) {
        expect(result.currentEftp).not.toBeNull();
        if (result.currentEftp != null) {
          expect(result.currentEftp).toBeGreaterThan(50);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Efficiency — aerobic decoupling with real data
  // ══════════════════════════════════════════════════════════════
  describe("efficiency aerobicDecoupling", () => {
    it("returns decoupling results for activities with sufficient samples", async () => {
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
      >("efficiency.aerobicDecoupling", { days: 180 });

      expect(Array.isArray(result)).toBe(true);

      // Our 1800-sample activities (30 min @ 1s intervals) should qualify (>= 600 samples)
      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(row.activityType).toBeTruthy();
        expect(typeof row.firstHalfRatio).toBe("number");
        expect(typeof row.secondHalfRatio).toBe("number");
        expect(typeof row.decouplingPct).toBe("number");
        expect(row.totalSamples).toBeGreaterThanOrEqual(600);
        // First and second half ratios should be positive
        expect(row.firstHalfRatio).toBeGreaterThan(0);
        expect(row.secondHalfRatio).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Cycling Advanced — training monotony
  // ══════════════════════════════════════════════════════════════
  describe("cyclingAdvanced", () => {
    it("trainingMonotony returns weekly monotony and strain values", async () => {
      const result = await query<
        {
          week: string;
          monotony: number;
          strain: number;
          weeklyLoad: number;
        }[]
      >("cyclingAdvanced.trainingMonotony", { days: 90 });

      expect(Array.isArray(result)).toBe(true);

      for (const week of result) {
        expect(week.week).toBeTruthy();
        expect(typeof week.monotony).toBe("number");
        expect(week.monotony).toBeGreaterThan(0);
        expect(typeof week.strain).toBe("number");
        expect(week.strain).toBeGreaterThan(0);
        expect(typeof week.weeklyLoad).toBe("number");
        expect(week.weeklyLoad).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Nutrition Analytics — adaptive TDEE
  // ══════════════════════════════════════════════════════════════
  describe("nutritionAnalytics", () => {
    it("adaptiveTdee returns TDEE estimate with weight smoothing", async () => {
      const result = await query<{
        estimatedTdee: number | null;
        confidence: number;
        dataPoints: number;
        dailyData: {
          date: string;
          caloriesIn: number;
          weightKg: number | null;
          smoothedWeight: number | null;
          estimatedTdee: number | null;
        }[];
      }>("nutritionAnalytics.adaptiveTdee", { days: 90 });

      expect(Array.isArray(result.dailyData)).toBe(true);
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(typeof result.dataPoints).toBe("number");

      for (const day of result.dailyData) {
        expect(day.date).toBeTruthy();
        expect(typeof day.caloriesIn).toBe("number");
      }
    });

    it("caloricBalance returns daily calorie balance with rolling avg", async () => {
      const result = await query<
        {
          date: string;
          caloriesIn: number;
          activeEnergy: number;
          basalEnergy: number;
          totalExpenditure: number;
          balance: number;
          rollingAvgBalance: number | null;
        }[]
      >("nutritionAnalytics.caloricBalance", { days: 30 });

      expect(Array.isArray(result)).toBe(true);

      for (const row of result) {
        expect(row.date).toBeTruthy();
        expect(typeof row.caloriesIn).toBe("number");
        expect(typeof row.activeEnergy).toBe("number");
        expect(typeof row.basalEnergy).toBe("number");
        expect(typeof row.totalExpenditure).toBe("number");
        expect(typeof row.balance).toBe("number");
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
        const total = row.proteinPct + row.carbsPct + row.fatPct;
        expect(total).toBeGreaterThan(90);
        expect(total).toBeLessThan(110);

        if (row.proteinPerKg != null) {
          expect(row.proteinPerKg).toBeGreaterThan(0);
        }
      }
    });

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
  });

  // ══════════════════════════════════════════════════════════════
  // Predictions — activity-level targets (cardio + strength)
  // ══════════════════════════════════════════════════════════════
  describe("predictions activity-level", () => {
    it("predict for cardio_power exercises trainActivityPrediction cardio path", async () => {
      const result = await query<{
        targetId: string;
        targetLabel: string;
        targetUnit: string;
        featureImportances: { name: string; treeImportance: number }[];
        predictions: { date: string; actual: number }[];
        diagnostics: Record<string, unknown>;
        tomorrowPrediction: { linear: number; tree: number } | null;
      } | null>("predictions.predict", { target: "cardio_power", days: 365 });

      // May be null if not enough cardio activities with power data
      // Either way should not throw
      if (result != null) {
        expect(result.targetId).toBe("cardio_power");
        expect(Array.isArray(result.featureImportances)).toBe(true);
        expect(Array.isArray(result.predictions)).toBe(true);
      }
    });

    it("predict for strength_volume exercises trainActivityPrediction strength path", async () => {
      const result = await query<{
        targetId: string;
        targetLabel: string;
        targetUnit: string;
        featureImportances: { name: string; treeImportance: number }[];
        predictions: { date: string; actual: number }[];
        diagnostics: Record<string, unknown>;
        tomorrowPrediction: { linear: number; tree: number } | null;
      } | null>("predictions.predict", { target: "strength_volume", days: 365 });

      // May be null if not enough strength workouts
      // Either way should not throw
      if (result != null) {
        expect(result.targetId).toBe("strength_volume");
        expect(Array.isArray(result.featureImportances)).toBe(true);
        expect(Array.isArray(result.predictions)).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Activity — byId, stream, hrZones
  // ══════════════════════════════════════════════════════════════
  describe("activity", () => {
    it("list returns recent activities", async () => {
      const result = await query<{
        items: { id: string; activity_type: string }[];
        totalCount: number;
      }>("activity.list", {
        days: 90,
      });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.totalCount).toBeGreaterThanOrEqual(result.items.length);
    });

    it("byId returns activity detail with summary data", async () => {
      // First get an activity id from list
      const list = await query<{ items: { id: string }[] }>("activity.list", { days: 90 });
      expect(list.items.length).toBeGreaterThan(0);
      const activityId = list.items[0]?.id;
      expect(activityId).toBeTruthy();

      const result = await query<{
        id: string;
        activityType: string;
        startedAt: string;
        name: string | null;
        providerId: string;
        avgHr: number | null;
        avgPower: number | null;
        sampleCount: number | null;
      }>("activity.byId", { id: activityId });

      expect(result.id).toBe(activityId);
      expect(result.activityType).toBeTruthy();
      expect(result.startedAt).toBeTruthy();
      expect(result.providerId).toBeTruthy();
    });

    it("byId throws NOT_FOUND for non-existent activity", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000099";
      try {
        await query("activity.byId", { id: fakeId });
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(String(err)).toContain("error");
      }
    });

    it("stream returns downsampled metric data for an activity", async () => {
      const list = await query<{ items: { id: string }[] }>("activity.list", { days: 90 });
      const activityId = list.items[0]?.id;
      expect(activityId).toBeTruthy();

      const result = await query<
        {
          recordedAt: string;
          heartRate: number | null;
          power: number | null;
          speed: number | null;
        }[]
      >("activity.stream", { id: activityId, maxPoints: 100 });

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(100);

      for (const point of result) {
        expect(point.recordedAt).toBeTruthy();
      }
    });

    it("hrZones returns 5-zone distribution for an activity", async () => {
      const list = await query<{ items: { id: string }[] }>("activity.list", { days: 90 });
      const activityId = list.items[0]?.id;
      expect(activityId).toBeTruthy();

      const result = await query<
        {
          zone: number;
          label: string;
          minPct: number;
          maxPct: number;
          seconds: number;
        }[]
      >("activity.hrZones", { id: activityId });

      expect(result).toHaveLength(5);

      for (const zone of result) {
        expect(zone.zone).toBeGreaterThanOrEqual(1);
        expect(zone.zone).toBeLessThanOrEqual(5);
        expect(zone.label).toBeTruthy();
        expect(zone.seconds).toBeGreaterThanOrEqual(0);
      }

      // At least some zones should have time with our HR data
      const totalSeconds = result.reduce((sum, z) => sum + z.seconds, 0);
      expect(totalSeconds).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sync — providers listing
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
      const testProvider = result.find((r) => r.providerId === "test_provider");
      if (testProvider) {
        expect(testProvider.activities).toBeGreaterThan(0);
        expect(testProvider.dailyMetrics).toBeGreaterThan(0);
        expect(testProvider.sleepSessions).toBeGreaterThan(0);
        expect(testProvider.metricStream).toBeGreaterThan(0);
      }
    });

    it("logs returns sync log history", async () => {
      const result = await query<unknown[]>("sync.logs", { limit: 10 });
      expect(Array.isArray(result)).toBe(true);
    });

    it("syncStatus returns null for unknown job", async () => {
      const result = await query<null>("sync.syncStatus", { jobId: "nonexistent-job-id" });
      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // PMC — chart with enough data for model estimation
  // ══════════════════════════════════════════════════════════════
  describe("pmc", () => {
    it("chart returns FTP estimate and load data", async () => {
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

      const loadDays = result.data.filter((d) => d.load > 0);
      expect(loadDays.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Healthspan — score with weekly history
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

      if (result.history.length >= 4) {
        expect(result.trend).not.toBeNull();
        expect(["improving", "declining", "stable"]).toContain(result.trend);
      }

      for (const metric of result.metrics) {
        expect(["excellent", "good", "fair", "poor"]).toContain(metric.status);
        expect(metric.score).toBeGreaterThanOrEqual(0);
        expect(metric.score).toBeLessThanOrEqual(100);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Efficiency — aerobicEfficiency with Z2 data
  // ══════════════════════════════════════════════════════════════
  describe("efficiency", () => {
    it("aerobicEfficiency returns EF for activities with Z2 data", async () => {
      const result = await query<{
        maxHr: number | null;
        activities: {
          date: string;
          activityType: string;
          name: string;
          avgPowerZ2: number;
          avgHrZ2: number;
          efficiencyFactor: number;
          z2Samples: number;
        }[];
      }>("efficiency.aerobicEfficiency", { days: 180 });

      expect(result.maxHr).toBe(190);
      expect(Array.isArray(result.activities)).toBe(true);

      for (const act of result.activities) {
        expect(act.date).toBeTruthy();
        expect(act.avgPowerZ2).toBeGreaterThan(0);
        expect(act.avgHrZ2).toBeGreaterThan(0);
        expect(act.efficiencyFactor).toBeGreaterThan(0);
        expect(act.z2Samples).toBeGreaterThanOrEqual(300);
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
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Power — powerCurve and eFTP trend
  // ══════════════════════════════════════════════════════════════
  describe("power", () => {
    it("powerCurve returns best power per duration", async () => {
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
    });

    it("eftpTrend returns per-activity eFTP", async () => {
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

      if (result.trend.length > 0) {
        expect(result.currentEftp).not.toBeNull();
      }
    });
  });

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
  // Life Events — CRUD and analyze
  // ══════════════════════════════════════════════════════════════
  describe("lifeEvents", () => {
    it("create + list + update + delete lifecycle", async () => {
      // Create
      const created = await mutate<{
        id: string;
        label: string;
        category: string | null;
      }>("lifeEvents.create", {
        label: "Coverage Test Event",
        startedAt: "2025-01-15",
        endedAt: "2025-02-15",
        category: "health",
        ongoing: false,
        notes: "Test notes",
      });
      expect(created.id).toBeTruthy();
      expect(created.label).toBe("Coverage Test Event");

      // List
      await queryCache.invalidateAll();
      const list = await query<{ id: string; label: string }[]>("lifeEvents.list");
      expect(list.some((e) => e.id === created.id)).toBe(true);

      // Update
      const updated = await mutate<{ id: string; label: string } | null>("lifeEvents.update", {
        id: created.id,
        label: "Updated Event",
        notes: null,
        category: null,
        endedAt: null,
      });
      expect(updated).not.toBeNull();
      expect(updated?.label).toBe("Updated Event");

      // Analyze
      const analysis = await query<{
        event: Record<string, unknown>;
        metrics: unknown[];
        sleep: unknown[];
        bodyComp: unknown[];
      } | null>("lifeEvents.analyze", { id: created.id, windowDays: 30 });
      expect(analysis).not.toBeNull();
      if (analysis) {
        expect(analysis.event).toBeDefined();
        expect(Array.isArray(analysis.metrics)).toBe(true);
        expect(Array.isArray(analysis.sleep)).toBe(true);
        expect(Array.isArray(analysis.bodyComp)).toBe(true);
      }

      // Delete
      const deleteResult = await mutate<{ success: boolean }>("lifeEvents.delete", {
        id: created.id,
      });
      expect(deleteResult.success).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Auth — linked accounts and unlinking
  // ══════════════════════════════════════════════════════════════
  describe("auth", () => {
    it("linkedAccounts returns linked auth_accounts for current user", async () => {
      const result =
        await query<
          { id: string; authProvider: string; email: string | null; name: string | null }[]
        >("auth.linkedAccounts");
      expect(Array.isArray(result)).toBe(true);
    });

    it("unlinkAccount rejects when user has fewer than 2 accounts", async () => {
      // With 0 or 1 accounts, unlinking should fail
      await expect(
        mutate("auth.unlinkAccount", { accountId: "00000000-0000-0000-0000-000000000099" }),
      ).rejects.toThrow(/Cannot unlink your only login method/);
    });

    it("unlinkAccount succeeds when user has 2+ accounts", async () => {
      // Insert two auth_account rows for the default user
      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (auth_provider, provider_account_id, user_id, email, name)
            VALUES ('test-provider-a', 'acct-a', ${DEFAULT_USER_ID}, 'a@test.com', 'A')
            ON CONFLICT DO NOTHING`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (auth_provider, provider_account_id, user_id, email, name)
            VALUES ('test-provider-b', 'acct-b', ${DEFAULT_USER_ID}, 'b@test.com', 'B')
            ON CONFLICT DO NOTHING`,
      );
      await queryCache.invalidateAll();

      const accounts = await query<{ id: string; authProvider: string }[]>("auth.linkedAccounts");
      expect(accounts.length).toBeGreaterThanOrEqual(2);

      // Unlink the first one
      const toUnlink = accounts[0];
      if (toUnlink) {
        const result = await mutate<{ ok: boolean }>("auth.unlinkAccount", {
          accountId: toUnlink.id,
        });
        expect(result.ok).toBe(true);
      }

      // Clean up remaining test accounts
      await testCtx.db.execute(
        sql`DELETE FROM fitness.auth_account WHERE user_id = ${DEFAULT_USER_ID}`,
      );
    });

    it("unlinkAccount returns not found for non-existent account", async () => {
      // Insert 2 accounts so the count check passes, then try to unlink a non-existent ID
      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (auth_provider, provider_account_id, user_id, email, name)
            VALUES ('test-x', 'x1', ${DEFAULT_USER_ID}, 'x@test.com', 'X')
            ON CONFLICT DO NOTHING`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.auth_account (auth_provider, provider_account_id, user_id, email, name)
            VALUES ('test-y', 'y1', ${DEFAULT_USER_ID}, 'y@test.com', 'Y')
            ON CONFLICT DO NOTHING`,
      );
      await queryCache.invalidateAll();

      await expect(
        mutate("auth.unlinkAccount", { accountId: "00000000-0000-0000-0000-000000000099" }),
      ).rejects.toThrow(/not found/i);

      // Clean up
      await testCtx.db.execute(
        sql`DELETE FROM fitness.auth_account WHERE user_id = ${DEFAULT_USER_ID}`,
      );
    });
  });
});
