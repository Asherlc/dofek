import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

/**
 * Integration tests for the predictions router.
 * Inserts enough synthetic data for the ML models to train,
 * then verifies the API returns valid prediction results.
 */
describe("Predictions router (integration)", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Insert a test provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Set user profile with max_hr and ftp
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50, ftp = 250
          WHERE id = ${DEFAULT_USER_ID}`,
    );

    // Insert 120 days of daily metrics (HRV, resting HR)
    for (let i = 120; i >= 0; i--) {
      const hrv = 50 + Math.sin(i * 0.3) * 10 + (i % 7) * 0.5;
      const rhr = 55 - Math.cos(i * 0.3) * 5;
      await testCtx.db.execute(
        sql`INSERT INTO fitness.daily_metrics (
              date, provider_id, user_id, resting_hr, hrv
            ) VALUES (
              CURRENT_DATE - ${i}::int,
              'test_provider', ${DEFAULT_USER_ID},
              ${Math.round(rhr)}, ${Math.round(hrv * 10) / 10}
            )`,
      );
    }

    // Insert 120 days of sleep data
    for (let i = 120; i >= 0; i--) {
      const duration = 420 + Math.sin(i * 0.4) * 40;
      const deep = Math.round(duration * 0.2);
      const rem = Math.round(duration * 0.25);
      const light = Math.round(duration * 0.45);
      const awake = Math.round(duration * 0.1);
      const efficiency = 82 + Math.sin(i * 0.5) * 6;

      await testCtx.db.execute(
        sql`INSERT INTO fitness.sleep_session (
              provider_id, user_id, started_at, ended_at,
              duration_minutes, deep_minutes, rem_minutes, light_minutes,
              awake_minutes, efficiency_pct, sleep_type
            ) VALUES (
              'test_provider', ${DEFAULT_USER_ID},
              (CURRENT_DATE - ${i}::int)::timestamp + INTERVAL '22 hours',
              (CURRENT_DATE - ${i}::int + 1)::timestamp + INTERVAL '6 hours',
              ${Math.round(duration)}, ${deep}, ${rem}, ${light},
              ${awake}, ${Math.round(efficiency * 10) / 10}, 'sleep'
            )`,
      );
    }

    // Insert 60 cycling activities with metric_stream (for activity predictions)
    for (let i = 60; i >= 1; i--) {
      if (i % 2 !== 0) continue;

      const durationMin = 50 + Math.round(Math.sin(i) * 15);
      const avgHr = 148 + Math.round(Math.sin(i * 0.5) * 8);
      const avgPower = 190 + Math.round(Math.cos(i * 0.3) * 25);

      const actResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, activity_type, started_at, ended_at, name
            ) VALUES (
              'test_provider', ${DEFAULT_USER_ID}, 'cycling',
              CURRENT_TIMESTAMP - ${i}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${i}::int * INTERVAL '1 day' + ${durationMin}::int * INTERVAL '1 minute',
              'Training Ride'
            ) RETURNING id`,
      );
      const actId = actResult[0]?.id;

      if (actId) {
        // Insert metric stream samples (1 per minute)
        const metricValues: string[] = [];
        const sensorValues: string[] = [];
        for (let s = 0; s < durationMin; s++) {
          const hr = avgHr + Math.round(Math.sin(s * 0.1) * 5);
          const power = avgPower + Math.round(Math.cos(s * 0.1) * 15);
          const ts = `CURRENT_TIMESTAMP - ${i} * INTERVAL '1 day' + ${s} * INTERVAL '1 minute'`;
          metricValues.push(
            `(${ts}, '${DEFAULT_USER_ID}', '${actId}', 'test_provider', ${hr}, ${power})`,
          );
          sensorValues.push(
            `(${ts}, '${DEFAULT_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${actId}', ${hr}, NULL)`,
            `(${ts}, '${DEFAULT_USER_ID}', 'test_provider', NULL, 'api', 'power', '${actId}', ${power}, NULL)`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
                recorded_at, user_id, activity_id, provider_id, heart_rate, power
              ) VALUES ${metricValues.join(",")}`),
        );
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.sensor_sample (
                recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
              ) VALUES ${sensorValues.join(",")}`),
        );
      }
    }

    // Insert strength workouts (for activity predictions)
    const exerciseResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.exercise (name, muscle_group)
          VALUES ('Bench Press', 'chest')
          RETURNING id`,
    );
    const exerciseId = exerciseResult[0]?.id;

    for (let i = 60; i >= 1; i--) {
      if (i % 3 !== 0) continue;

      const workoutResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.strength_workout (
              provider_id, user_id, started_at, ended_at, name
            ) VALUES (
              'test_provider', ${DEFAULT_USER_ID},
              CURRENT_TIMESTAMP - ${i}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${i}::int * INTERVAL '1 day' + INTERVAL '45 minutes',
              'Upper Body'
            ) RETURNING id`,
      );
      const workoutId = workoutResult[0]?.id;

      if (workoutId && exerciseId) {
        const weight = 70 + (60 - i) * 0.5;
        for (let setIdx = 0; setIdx < 3; setIdx++) {
          await testCtx.db.execute(
            sql`INSERT INTO fitness.strength_set (
                  workout_id, exercise_id, exercise_index, set_index,
                  set_type, weight_kg, reps
                ) VALUES (
                  ${workoutId}, ${exerciseId}, 0, ${setIdx},
                  'working', ${weight}, 8
                )`,
          );
        }
      }
    }

    // Refresh materialized views
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);

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

  async function query<T = unknown>(path: string, input: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data: Record<string, unknown>[] = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  describe("targets", () => {
    it("returns all available prediction targets", async () => {
      const result =
        await query<{ id: string; label: string; unit: string; type: "daily" | "activity" }[]>(
          "predictions.targets",
        );

      expect(result.length).toBeGreaterThan(0);

      // Should have both daily and activity targets
      const types = new Set(result.map((t) => t.type));
      expect(types.has("daily")).toBe(true);

      // Each target should have proper metadata
      for (const target of result) {
        expect(target.id).toBeTruthy();
        expect(target.label).toBeTruthy();
        expect(target.unit).toBeTruthy();
      }
    });
  });

  describe("predict — daily targets", () => {
    it("trains HRV prediction model", async () => {
      const result = await query<{
        targetId: string;
        targetLabel: string;
        targetUnit: string;
        featureImportances: { name: string; treeImportance: number }[];
        predictions: { date: string; actual: number; linearPrediction: number }[];
        diagnostics: {
          linearRSquared: number;
          treeRSquared: number;
          sampleCount: number;
          featureCount: number;
        };
        tomorrowPrediction: { linear: number; tree: number } | null;
      }>("predictions.predict", { target: "hrv", days: 365 });

      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.targetId).toBe("hrv");
      expect(result.predictions.length).toBeGreaterThan(30);
      expect(result.featureImportances.length).toBeGreaterThan(0);
      expect(result.diagnostics.sampleCount).toBeGreaterThan(30);
      expect(result.diagnostics.featureCount).toBeGreaterThan(0);

      // Predictions should have valid dates
      for (const pred of result.predictions) {
        expect(pred.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(pred.actual).toBeTypeOf("number");
        expect(pred.linearPrediction).toBeTypeOf("number");
      }

      // Tomorrow prediction should exist with enough data
      expect(result.tomorrowPrediction).not.toBeNull();
    });

    it("trains resting HR prediction model", async () => {
      const result = await query<{
        targetId: string;
        diagnostics: { sampleCount: number };
        featureImportances: { name: string }[];
      }>("predictions.predict", { target: "resting_hr", days: 365 });

      expect(result).not.toBeNull();
      if (!result) return;

      expect(result.targetId).toBe("resting_hr");
      expect(result.diagnostics.sampleCount).toBeGreaterThan(0);

      // Should not include resting_hr or hrv as features
      const featureNames = result.featureImportances.map((f) => f.name);
      expect(featureNames).not.toContain("resting_hr");
      expect(featureNames).not.toContain("hrv");
    });
  });

  describe("predict — unknown target", () => {
    it("returns null for non-existent target", async () => {
      const result = await query("predictions.predict", {
        target: "nonexistent_target",
        days: 365,
      });

      expect(result).toBeNull();
    });
  });
});
