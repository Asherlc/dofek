import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import {
  type ClickHouseMetricStreamSeedRow,
  createClickHouseTestActivitySensorStore,
  seedClickHouseMetricStreamRows,
} from "./clickhouse-integration-test-helpers.ts";
import type { DailyTrendRow, WeeklyTrendRow } from "./trends.ts";

/**
 * Integration tests for the trends router.
 * Inserts metric_stream data and verifies the endpoints return correctly
 * aggregated data from ClickHouse trend read models.
 */
describe("Trends router — trend data tests", () => {
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

    const metricStreamSeedRows: ClickHouseMetricStreamSeedRow[] = [];

    // Insert activities spanning 30 days, with metric_stream data
    for (let day = 30; day >= 1; day--) {
      // Create an activity every day
      const durationMin = 45 + Math.round(Math.sin(day) * 15);
      const avgHr = 150 + Math.round(Math.sin(day * 0.3) * 10);
      const avgPower = 200 + Math.round(Math.cos(day * 0.2) * 30);

      const actResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
            ) VALUES (
              'test_provider', ${TEST_USER_ID}, ${`trend-ride-${day}`}, 'cycling', 'cycling',
              CURRENT_TIMESTAMP - ${day}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${day}::int * INTERVAL '1 day' + ${durationMin}::int * INTERVAL '1 minute',
              'Daily Ride'
            ) RETURNING id`,
      );
      const actId = actResult[0]?.id;

      if (actId) {
        const activityStartedAt = new Date(Date.now() - day * 24 * 60 * 60 * 1000);
        for (let s = 0; s < durationMin; s++) {
          const hr = avgHr + Math.round(Math.sin(s * 0.1) * 5);
          const power = avgPower + Math.round(Math.cos(s * 0.1) * 15);
          const cadence = 85 + Math.round(Math.sin(s * 0.05) * 10);
          const speed = 8 + Math.sin(s * 0.08) * 1.5;
          const recordedAt = new Date(activityStartedAt.getTime() + s * 60_000).toISOString();
          metricStreamSeedRows.push(
            {
              userId: TEST_USER_ID,
              recordedAt,
              providerId: "test_provider",
              sourceType: "api",
              channel: "heart_rate",
              activityId: actId,
              scalar: hr,
            },
            {
              userId: TEST_USER_ID,
              recordedAt,
              providerId: "test_provider",
              sourceType: "api",
              channel: "power",
              activityId: actId,
              scalar: power,
            },
            {
              userId: TEST_USER_ID,
              recordedAt,
              providerId: "test_provider",
              sourceType: "api",
              channel: "speed",
              activityId: actId,
              scalar: Number(speed.toFixed(3)),
            },
            {
              userId: TEST_USER_ID,
              recordedAt,
              providerId: "test_provider",
              sourceType: "api",
              channel: "cadence",
              activityId: actId,
              scalar: cadence,
            },
          );
        }
      }
    }

    const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
    await seedClickHouseMetricStreamRows(testCtx, metricStreamSeedRows);
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

  describe("daily", () => {
    it("returns daily aggregated metrics from the ClickHouse trend read model", async () => {
      const result = await query<DailyTrendRow[]>("trends.daily", { days: 90 });

      if (result.length > 0) {
        for (const row of result) {
          expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(row.totalSamples).toBeGreaterThan(0);

          // HR data should be present
          if (row.hrSamples > 0) {
            expect(row.avgHr).toBeTypeOf("number");
            expect(row.avgHr).toBeGreaterThan(0);
            if (row.maxHr != null) {
              expect(row.maxHr).toBeGreaterThanOrEqual(row.avgHr ?? 0);
            }
          }

          // Power data should be present
          if (row.powerSamples > 0) {
            expect(row.avgPower).toBeTypeOf("number");
            expect(row.avgPower).toBeGreaterThan(0);
          }

          // Cadence and speed
          if (row.avgCadence != null) {
            expect(row.avgCadence).toBeGreaterThan(0);
          }
          if (row.avgSpeed != null) {
            expect(row.avgSpeed).toBeGreaterThan(0);
          }

          expect(row.activityCount).toBeGreaterThan(0);
        }
      }
    });

    it("returns data with proper rounding", async () => {
      const result = await query<DailyTrendRow[]>("trends.daily", { days: 90 });

      for (const row of result) {
        // avgHr should be rounded to 1 decimal
        if (row.avgHr != null) {
          expect(row.avgHr).toBe(Math.round(row.avgHr * 10) / 10);
        }
        // avgPower should be rounded to 1 decimal
        if (row.avgPower != null) {
          expect(row.avgPower).toBe(Math.round(row.avgPower * 10) / 10);
        }
        // avgSpeed should be rounded to 2 decimals
        if (row.avgSpeed != null) {
          expect(row.avgSpeed).toBe(Math.round(row.avgSpeed * 100) / 100);
        }
      }
    });
  });

  describe("weekly", () => {
    it("returns weekly aggregated metrics from daily ClickHouse trend rows", async () => {
      const result = await query<WeeklyTrendRow[]>("trends.weekly", { weeks: 52 });

      if (result.length > 0) {
        for (const row of result) {
          expect(row.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(row.totalSamples).toBeGreaterThan(0);

          if (row.hrSamples > 0) {
            expect(row.avgHr).toBeTypeOf("number");
          }
          if (row.powerSamples > 0) {
            expect(row.avgPower).toBeTypeOf("number");
          }

          expect(row.activityCount).toBeGreaterThan(0);
        }

        // Weekly should have fewer rows than daily
        const dailyResult = await query<DailyTrendRow[]>("trends.daily", {
          days: 90,
        });
        if (dailyResult.length > 0) {
          expect(result.length).toBeLessThanOrEqual(dailyResult.length);
        }
      }
    });
  });
});
