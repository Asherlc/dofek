import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";

/**
 * Integration tests for the duration-curves router with actual metric_stream data.
 * Inserts HR and speed samples, then verifies the HR curve and pace curve endpoints.
 */
describe("Duration curves router — data tests", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Insert a test provider
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test_provider', 'Test Provider', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert a running activity (60 minutes)
    const actResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'running',
            CURRENT_TIMESTAMP - INTERVAL '2 days',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '60 minutes',
            'Test Run'
          ) RETURNING id`,
    );
    const runId = actResult[0]?.id;

    if (runId) {
      // Insert 3600 samples (1 per second for 60 minutes)
      // HR starts at 130 and rises to 180 over the run
      // Speed is ~3.5 m/s (about 4:45/km pace)
      const batchSize = 300;
      for (let batch = 0; batch < 3600; batch += batchSize) {
        const metricValues: string[] = [];
        const sensorValues: string[] = [];
        for (let s = batch; s < Math.min(batch + batchSize, 3600); s++) {
          const hr = 130 + Math.round((s / 3600) * 50 + Math.sin(s * 0.02) * 5);
          const speed = 3.2 + Math.sin(s * 0.01) * 0.5; // ~3.2 m/s with variation
          const ts = `CURRENT_TIMESTAMP - INTERVAL '2 days' + ${s} * INTERVAL '1 second'`;
          metricValues.push(
            `(${ts}, '${TEST_USER_ID}', '${runId}', 'test_provider', ${hr}, null, ${speed.toFixed(3)})`,
          );
          sensorValues.push(
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${runId}', ${hr}, NULL)`,
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'speed', '${runId}', ${speed.toFixed(3)}, NULL)`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
                recorded_at, user_id, activity_id, provider_id, heart_rate, power, speed
              ) VALUES ${metricValues.join(",")}`),
        );
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.sensor_sample (
                recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
              ) VALUES ${sensorValues.join(",")}`),
        );
      }
    }

    // Insert a cycling activity (45 minutes) with HR and power
    const cycleResult = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, activity_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'cycling',
            CURRENT_TIMESTAMP - INTERVAL '5 days',
            CURRENT_TIMESTAMP - INTERVAL '5 days' + INTERVAL '45 minutes',
            'Test Ride'
          ) RETURNING id`,
    );
    const cycleId = cycleResult[0]?.id;

    if (cycleId) {
      const batchSize = 300;
      for (let batch = 0; batch < 2700; batch += batchSize) {
        const metricValues: string[] = [];
        const sensorValues: string[] = [];
        for (let s = batch; s < Math.min(batch + batchSize, 2700); s++) {
          const hr = 140 + Math.round((s / 2700) * 40 + Math.sin(s * 0.015) * 8);
          const ts = `CURRENT_TIMESTAMP - INTERVAL '5 days' + ${s} * INTERVAL '1 second'`;
          metricValues.push(
            `(${ts}, '${TEST_USER_ID}', '${cycleId}', 'test_provider', ${hr}, null, null)`,
          );
          sensorValues.push(
            `(${ts}, '${TEST_USER_ID}', 'test_provider', NULL, 'api', 'heart_rate', '${cycleId}', ${hr}, NULL)`,
          );
        }
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.metric_stream (
                recorded_at, user_id, activity_id, provider_id, heart_rate, power, speed
              ) VALUES ${metricValues.join(",")}`),
        );
        await testCtx.db.execute(
          sql.raw(`INSERT INTO fitness.sensor_sample (
                recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar, vector
              ) VALUES ${sensorValues.join(",")}`),
        );
      }
    }

    // Refresh materialized views so the queries can join against them
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.v_activity`);

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
    const data = await res.json();
    const first: { result?: { data?: T }; error?: { message: string } } = data[0];
    if (first?.error) {
      throw new Error(`${path} error: ${JSON.stringify(first.error)}`);
    }
    return first?.result?.data;
  }

  describe("hrCurve", () => {
    it("returns HR duration curve points from metric_stream data", async () => {
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

      // HR should decrease as duration increases (can sustain less HR for longer)
      const sorted = [...result.points].sort((a, b) => a.durationSeconds - b.durationSeconds);
      for (const point of sorted) {
        expect(point.durationSeconds).toBeGreaterThan(0);
        expect(point.bestHeartRate).toBeGreaterThan(0);
        expect(point.bestHeartRate).toBeLessThan(250);
        expect(point.label).toBeTruthy();
        expect(point.activityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      // Short durations should generally have higher HR than long durations
      if (sorted.length >= 2) {
        const shortDuration = sorted[0];
        const longDuration = sorted[sorted.length - 1];
        if (shortDuration && longDuration) {
          expect(shortDuration.bestHeartRate).toBeGreaterThanOrEqual(
            longDuration.bestHeartRate - 10, // allow some tolerance
          );
        }
      }
    });

    it("returns a critical heart rate model when enough data points exist", async () => {
      const result = await query<{
        points: { durationSeconds: number; bestHeartRate: number }[];
        model: { thresholdHr: number; r2: number } | null;
      }>("durationCurves.hrCurve", { days: 90 });

      // With 2 activities and multiple durations, model should be fit
      if (result.points.filter((p) => p.durationSeconds >= 120).length >= 3) {
        expect(result.model).not.toBeNull();
        if (result.model) {
          expect(result.model.thresholdHr).toBeGreaterThan(100);
          expect(result.model.thresholdHr).toBeLessThan(220);
          expect(result.model.r2).toBeGreaterThanOrEqual(0);
          expect(result.model.r2).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe("paceCurve", () => {
    it("returns pace duration curve points from speed data", async () => {
      const result = await query<{
        points: {
          durationSeconds: number;
          label: string;
          bestPaceSecondsPerKm: number;
          activityDate: string;
        }[];
      }>("durationCurves.paceCurve", { days: 90 });

      expect(result.points.length).toBeGreaterThan(0);

      for (const point of result.points) {
        expect(point.durationSeconds).toBeGreaterThan(0);
        expect(point.bestPaceSecondsPerKm).toBeGreaterThan(0);
        expect(point.label).toBeTruthy();
        expect(point.activityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      // Pace should generally get slower (higher s/km) at longer durations
      const sorted = [...result.points].sort((a, b) => a.durationSeconds - b.durationSeconds);
      if (sorted.length >= 2) {
        const shortest = sorted[0];
        const longest = sorted[sorted.length - 1];
        if (shortest && longest) {
          // Best pace at short duration should be faster (lower s/km)
          // Allow generous tolerance since synthetic data has noise
          expect(shortest.bestPaceSecondsPerKm).toBeLessThanOrEqual(
            longest.bestPaceSecondsPerKm + 60, // 1 min/km tolerance
          );
        }
      }
    });
  });
});
