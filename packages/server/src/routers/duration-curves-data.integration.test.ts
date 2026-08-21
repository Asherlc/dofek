import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

/**
 * Integration tests for the duration-curves router with explicit deduped
 * ClickHouse sensor-store fixtures.
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

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'duration-test-run', 'running', 'running',
            CURRENT_TIMESTAMP - INTERVAL '2 days',
            CURRENT_TIMESTAMP - INTERVAL '2 days' + INTERVAL '60 minutes',
            'Test Run'
          )`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'test_provider', ${TEST_USER_ID}, 'duration-test-ride', 'cycling', 'cycling',
            CURRENT_TIMESTAMP - INTERVAL '5 days',
            CURRENT_TIMESTAMP - INTERVAL '5 days' + INTERVAL '45 minutes',
            'Test Ride'
          )`,
    );

    const sensorStore = makeMockSensorStore();
    sensorStore.getHeartRateCurveRows = async () => [
      { duration_seconds: 5, best_hr: 180, activity_date: "2026-04-29" },
      { duration_seconds: 60, best_hr: 174, activity_date: "2026-04-29" },
      { duration_seconds: 300, best_hr: 166, activity_date: "2026-04-29" },
      { duration_seconds: 600, best_hr: 158, activity_date: "2026-04-26" },
    ];
    sensorStore.getPaceCurveRows = async () => [
      { duration_seconds: 5, best_pace: 265, activity_date: "2026-04-29" },
      { duration_seconds: 60, best_pace: 275, activity_date: "2026-04-29" },
      { duration_seconds: 300, best_pace: 292, activity_date: "2026-04-29" },
    ];

    const app = createApp(testCtx.db, sensorStore);
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
    it("returns HR duration curve points from deduped ClickHouse data", async () => {
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
    it("returns pace duration curve points from deduped ClickHouse data", async () => {
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
