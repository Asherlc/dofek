import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";
import { createSession } from "../../auth/session.ts";
import { createApp } from "../../index.ts";
import { queryCache } from "../../lib/cache.ts";

/**
 * Integration tests that INSERT data and verify JS transformation logic
 * in tRPC router endpoints. Complements router-sql.test.ts (which tests
 * with empty tables) by exercising the data transformation paths.
 */

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

describe("Router transformation logic", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Insert a test provider (needed for FK constraints)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('test-provider', 'Test Provider', ${DEFAULT_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  /** POST a tRPC query and return parsed response */
  async function query(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  /** POST a tRPC mutation and return parsed response */
  async function mutate(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  /** Refresh all materialized views so inserted data is visible to queries */
  async function refreshViews() {
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_daily_metrics`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_sleep`);
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_activity`);
    await testCtx.db.execute(
      sql`REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_body_measurement`,
    );
    await testCtx.db.execute(sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`);
  }

  // ══════════════════════════════════════════════════════════════
  // Life Events — CRUD operations
  // ══════════════════════════════════════════════════════════════
  describe("lifeEvents CRUD", () => {
    let createdEventId: string;

    it("create inserts a life event and returns it", async () => {
      const { status, result } = await mutate("lifeEvents.create", {
        label: "Started new job",
        startedAt: "2025-06-01",
        category: "career",
        ongoing: true,
        notes: "Remote position",
      });
      expect(status).toBe(200);
      expect(result.result.data).toBeDefined();
      const event = result.result.data;
      expect(event.label).toBe("Started new job");
      expect(event.category).toBe("career");
      expect(event.ongoing).toBe(true);
      expect(event.notes).toBe("Remote position");
      expect(event.id).toBeDefined();
      createdEventId = event.id;
    });

    it("list returns the created event", async () => {
      const { status, result } = await query("lifeEvents.list");
      expect(status).toBe(200);
      const events = result.result.data;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const found = events.find((e: { id: string }) => e.id === createdEventId);
      expect(found).toBeDefined();
      expect(found.label).toBe("Started new job");
    });

    it("update modifies specific fields", async () => {
      const { status, result } = await mutate("lifeEvents.update", {
        id: createdEventId,
        label: "Left job",
        ongoing: false,
        endedAt: "2025-12-31",
      });
      expect(status).toBe(200);
      const updated = result.result.data;
      expect(updated.label).toBe("Left job");
      expect(updated.ongoing).toBe(false);
    });

    it("update all fields including null-clearing", async () => {
      // Covers: startedAt, category→null, notes→null, endedAt→null branches
      const { status, result } = await mutate("lifeEvents.update", {
        id: createdEventId,
        startedAt: "2025-07-01",
        endedAt: null,
        category: null,
        notes: null,
      });
      expect(status).toBe(200);
      const updated = result.result.data;
      expect(updated.ended_at).toBeNull();
      expect(updated.category).toBeNull();
      expect(updated.notes).toBeNull();
    });

    it("update with no fields returns null", async () => {
      const { status, result } = await mutate("lifeEvents.update", {
        id: createdEventId,
      });
      expect(status).toBe(200);
      expect(result.result.data).toBeNull();
    });

    it("delete removes the event", async () => {
      const { status, result } = await mutate("lifeEvents.delete", {
        id: createdEventId,
      });
      expect(status).toBe(200);
      expect(result.result.data.success).toBe(true);

      // Invalidate cache so the list query hits the DB again
      await queryCache.invalidateAll();

      // Verify it's gone
      const { result: listResult } = await query("lifeEvents.list");
      const events = listResult.result.data;
      const found = events.find((e: { id: string }) => e.id === createdEventId);
      expect(found).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sport Settings — CRUD + history
  // ══════════════════════════════════════════════════════════════
  describe("sportSettings CRUD", () => {
    let settingsId: string;

    it("upsert creates sport settings", async () => {
      const { status, result } = await mutate("sportSettings.upsert", {
        sport: "cycling",
        ftp: 250,
        thresholdHr: 165,
        effectiveFrom: "2025-01-01",
        notes: "Start of season",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.sport).toBe("cycling");
      expect(settings.ftp).toBe(250);
      expect(settings.threshold_hr).toBe(165);
      settingsId = settings.id;
    });

    it("upsert with same sport+date updates existing entry", async () => {
      const { status, result } = await mutate("sportSettings.upsert", {
        sport: "cycling",
        ftp: 260,
        thresholdHr: 168,
        effectiveFrom: "2025-01-01",
        notes: "Updated FTP",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.ftp).toBe(260);
      // Should be same id since ON CONFLICT updates
      expect(settings.id).toBe(settingsId);
    });

    it("upsert with different date creates new entry", async () => {
      const { status, result } = await mutate("sportSettings.upsert", {
        sport: "cycling",
        ftp: 270,
        thresholdHr: 170,
        effectiveFrom: "2025-06-01",
        notes: "Mid-season bump",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.ftp).toBe(270);
      expect(settings.id).not.toBe(settingsId);
    });

    it("list returns most recent per sport", async () => {
      const { status, result } = await query("sportSettings.list");
      expect(status).toBe(200);
      const list = result.result.data;
      // Should return only 1 entry for cycling (the most recent by effective_from)
      const cyclingEntries = list.filter((s: { sport: string }) => s.sport === "cycling");
      expect(cyclingEntries).toHaveLength(1);
      expect(cyclingEntries[0].ftp).toBe(270); // the June entry
    });

    it("getBySport returns setting effective at a specific date", async () => {
      // Ask for settings as of March 2025 — should get the Jan entry (FTP 260)
      const { status, result } = await query("sportSettings.getBySport", {
        sport: "cycling",
        asOfDate: "2025-03-15",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.ftp).toBe(260);
    });

    it("getBySport with future date returns latest", async () => {
      const { status, result } = await query("sportSettings.getBySport", {
        sport: "cycling",
        asOfDate: "2025-12-31",
      });
      expect(status).toBe(200);
      expect(result.result.data.ftp).toBe(270);
    });

    it("history returns all entries ordered by effective_from DESC", async () => {
      const { status, result } = await query("sportSettings.history", {
        sport: "cycling",
      });
      expect(status).toBe(200);
      const history = result.result.data;
      expect(history).toHaveLength(2);
      // Most recent first
      expect(history[0].ftp).toBe(270);
      expect(history[1].ftp).toBe(260);
    });

    it("delete removes a specific entry", async () => {
      const { status, result } = await mutate("sportSettings.delete", {
        id: settingsId,
      });
      expect(status).toBe(200);
      expect(result.result.data.success).toBe(true);

      // Invalidate cache so history query hits the DB again
      await queryCache.invalidateAll();

      const { result: histResult } = await query("sportSettings.history", {
        sport: "cycling",
      });
      expect(histResult.result.data).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sleep Need — Whoop-inspired sleep need formula
  // ══════════════════════════════════════════════════════════════
  describe("sleepNeed", () => {
    beforeAll(async () => {
      // Insert 30 nights of sleep data + daily HRV
      const sleepInserts: ReturnType<typeof sql>[] = [];
      const metricsInserts: ReturnType<typeof sql>[] = [];

      for (let i = 1; i <= 30; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);

        // Sleep: vary between 400-500 min
        const durationMin = 400 + Math.round(Math.sin(i) * 50);
        const startHour = 22;
        const startedAt = new Date(date);
        startedAt.setHours(startHour, 0, 0, 0);
        const endedAt = new Date(startedAt.getTime() + durationMin * 60 * 1000);

        sleepInserts.push(
          sql`INSERT INTO fitness.sleep_session
              (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, is_nap)
              VALUES ('test-provider', ${DEFAULT_USER_ID}, ${`sleep-${i}`}, ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${durationMin}, false)`,
        );

        // Daily metrics: HRV varies with sleep quality (higher sleep = higher HRV next day)
        const hrv = 40 + (durationMin - 400) * 0.5;
        metricsInserts.push(
          sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, hrv, resting_hr, steps)
              VALUES (${dateStr}::date, 'test-provider', ${DEFAULT_USER_ID}, ${hrv}, ${55 + Math.round(Math.random() * 10)}, ${8000 + Math.round(Math.random() * 4000)})
              ON CONFLICT DO NOTHING`,
        );
      }

      for (const insert of [...sleepInserts, ...metricsInserts]) {
        await testCtx.db.execute(insert);
      }

      await refreshViews();
    }, 30_000);

    it("returns personalized sleep need with data", async () => {
      const { status, result } = await query("sleepNeed.calculate", {
        targetWakeHour: 7,
        targetWakeMinute: 0,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // With 30 nights of data and varied HRV, we should get a calculated baseline
      expect(data.baselineMinutes).toBeGreaterThan(0);
      expect(data.totalNeedMinutes).toBeGreaterThan(0);
      expect(data.totalNeedMinutes).toBeGreaterThanOrEqual(data.baselineMinutes);
      expect(data.suggestedBedtime).toBeTruthy();
      expect(data.suggestedWakeTime).toBeTruthy();

      // Recent nights should have data
      expect(data.recentNights.length).toBeGreaterThan(0);
      expect(data.recentNights.length).toBeLessThanOrEqual(7);

      for (const night of data.recentNights) {
        expect(night.date).toBeTruthy();
        expect(night.actualMinutes).toBeGreaterThan(0);
        expect(night.neededMinutes).toBeGreaterThan(0);
        expect(night.debtMinutes).toBeGreaterThanOrEqual(0);
      }
    });

    it("accumulated debt reflects sleep deficits", async () => {
      const { status, result } = await query("sleepNeed.calculate", {
        targetWakeHour: 7,
        targetWakeMinute: 0,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // If baseline > some nights' durations, there should be accumulated debt
      // (our test data varies 400-500 min, so if baseline is ~450, some nights are below)
      expect(data.accumulatedDebtMinutes).toBeGreaterThanOrEqual(0);
      expect(typeof data.strainDebtMinutes).toBe("number");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Weekly Report — strain zones and sleep performance
  // ══════════════════════════════════════════════════════════════
  describe("weeklyReport", () => {
    beforeAll(async () => {
      // Insert activities with HR data for weekly report calculations
      // Need activities in the activity table + metric_stream for activity_summary
      const now = new Date();

      for (let week = 0; week < 8; week++) {
        for (let day = 0; day < 3; day++) {
          // 3 activities per week
          const activityDate = new Date(now);
          activityDate.setDate(activityDate.getDate() - week * 7 - day);
          const startedAt = new Date(activityDate);
          startedAt.setHours(8, 0, 0, 0);
          const endedAt = new Date(startedAt.getTime() + 60 * 60 * 1000); // 1 hour

          const externalId = `weekly-act-${week}-${day}`;

          await testCtx.db.execute(
            sql`INSERT INTO fitness.activity
                (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
                VALUES ('test-provider', ${DEFAULT_USER_ID}, ${externalId}, 'cycling', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${`Ride ${externalId}`})
                ON CONFLICT DO NOTHING`,
          );

          // Insert metric_stream data for activity_summary
          const activityRows = await testCtx.db.execute(
            sql`SELECT id FROM fitness.activity WHERE external_id = ${externalId} AND provider_id = 'test-provider'`,
          );
          const activityId = (activityRows[0] as { id: string } | undefined)?.id;
          if (activityId) {
            // Insert a few metric samples so activity_summary can compute stats
            for (let minute = 0; minute < 60; minute++) {
              const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
              await testCtx.db.execute(
                sql`INSERT INTO fitness.metric_stream
                    (recorded_at, user_id, activity_id, provider_id, heart_rate, power, speed)
                    VALUES (${sampleTime.toISOString()}, ${DEFAULT_USER_ID}, ${activityId}::uuid, 'test-provider', ${140 + Math.round(Math.random() * 20)}, ${180 + Math.round(Math.random() * 40)}, ${6.5 + Math.random()})`,
              );
            }
          }
        }
      }

      // Set max_hr on user profile for activity_summary calculations
      await testCtx.db.execute(
        sql`UPDATE fitness.user_profile SET max_hr = 190 WHERE id = ${DEFAULT_USER_ID}`,
      );

      await refreshViews();
    }, 120_000);

    it("returns weekly summaries with strain zones", async () => {
      const { status, result } = await query("weeklyReport.report", {
        weeks: 8,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data.current).toBeDefined();
      expect(data.history).toBeDefined();
      expect(Array.isArray(data.history)).toBe(true);

      if (data.current) {
        expect(data.current.weekStart).toBeTruthy();
        expect(typeof data.current.trainingHours).toBe("number");
        expect(typeof data.current.activityCount).toBe("number");
        expect(["restoring", "optimal", "overreaching"]).toContain(data.current.strainZone);
        expect(typeof data.current.avgDailyLoad).toBe("number");
        expect(typeof data.current.sleepPerformancePct).toBe("number");
      }

      // With 8 weeks of data, history should have entries
      if (data.history.length > 0) {
        for (const week of data.history) {
          expect(week.weekStart).toBeTruthy();
          expect(["restoring", "optimal", "overreaching"]).toContain(week.strainZone);
        }
      }
    });

    it("sleep performance is relative to previous weeks", async () => {
      const { status, result } = await query("weeklyReport.report", {
        weeks: 8,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // All weeks should have sleepPerformancePct as a number
      const allWeeks = [...data.history, ...(data.current ? [data.current] : [])];
      for (const week of allWeeks) {
        expect(typeof week.sleepPerformancePct).toBe("number");
        // Should be a reasonable percentage (0-200%ish)
        expect(week.sleepPerformancePct).toBeGreaterThanOrEqual(0);
        expect(week.sleepPerformancePct).toBeLessThanOrEqual(500);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Hiking — grade-adjusted pace cost factor model
  // ══════════════════════════════════════════════════════════════
  describe("hiking walkingBiomechanics", () => {
    beforeAll(async () => {
      // Update existing daily_metrics rows (already inserted by sleepNeed) to add walking data
      // Also insert additional rows for dates not covered by sleepNeed
      for (let i = 1; i <= 14; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);

        // Use UPDATE to add walking biomechanics to existing rows
        await testCtx.db.execute(
          sql`UPDATE fitness.daily_metrics
              SET walking_speed = ${1.2 + i * 0.01},
                  walking_step_length = ${70 + i * 0.5},
                  walking_double_support_pct = ${28 - i * 0.1},
                  walking_asymmetry_pct = ${3.5 + i * 0.05},
                  walking_steadiness = ${0.85 + i * 0.005}
              WHERE date = ${dateStr}::date
                AND provider_id = 'test-provider'
                AND user_id = ${DEFAULT_USER_ID}`,
        );

        // Also insert for dates not already present (beyond the 30 days from sleepNeed)
        await testCtx.db.execute(
          sql`INSERT INTO fitness.daily_metrics
              (date, provider_id, user_id, walking_speed, walking_step_length, walking_double_support_pct, walking_asymmetry_pct, walking_steadiness)
              VALUES (${dateStr}::date, 'test-provider', ${DEFAULT_USER_ID}, ${1.2 + i * 0.01}, ${70 + i * 0.5}, ${28 - i * 0.1}, ${3.5 + i * 0.05}, ${0.85 + i * 0.005})
              ON CONFLICT DO NOTHING`,
        );
      }
    }, 30_000);

    it("converts walking speed from m/s to km/h", async () => {
      const { status, result } = await query("hiking.walkingBiomechanics", {
        days: 30,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data.length).toBeGreaterThan(0);

      for (const row of data) {
        expect(row.date).toBeTruthy();
        // Walking speed should be in km/h (m/s * 3.6)
        // We inserted ~1.2-1.34 m/s, so km/h should be ~4.3-4.8
        if (row.walkingSpeedKmh !== null) {
          expect(row.walkingSpeedKmh).toBeGreaterThan(4);
          expect(row.walkingSpeedKmh).toBeLessThan(6);
        }
        if (row.stepLengthCm !== null) {
          expect(row.stepLengthCm).toBeGreaterThan(60);
          expect(row.stepLengthCm).toBeLessThan(90);
        }
        if (row.steadiness !== null) {
          expect(row.steadiness).toBeGreaterThanOrEqual(0);
          expect(row.steadiness).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Calendar — activity aggregation per day
  // ══════════════════════════════════════════════════════════════
  describe("calendar", () => {
    it("returns calendar data with activity counts and types", async () => {
      // Activities were already inserted in the weeklyReport beforeAll
      const { status, result } = await query("calendar.calendarData", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(Array.isArray(data)).toBe(true);
      if (data.length > 0) {
        const day = data[0];
        expect(day.date).toBeTruthy();
        expect(typeof day.activityCount).toBe("number");
        expect(day.activityCount).toBeGreaterThan(0);
        expect(typeof day.totalMinutes).toBe("number");
        expect(Array.isArray(day.activityTypes)).toBe(true);
        expect(day.activityTypes.length).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Healthspan — scoring functions produce correct ranges
  // ══════════════════════════════════════════════════════════════
  describe("healthspan", () => {
    beforeAll(async () => {
      // Set birth date for biological age calculation
      await testCtx.db.execute(
        sql`UPDATE fitness.user_profile
            SET birth_date = '1990-01-01'
            WHERE id = ${DEFAULT_USER_ID}`,
      );

      // Insert body measurement for lean mass calculation
      await testCtx.db.execute(
        sql`INSERT INTO fitness.body_measurement
            (provider_id, user_id, recorded_at, weight_kg, body_fat_pct)
            VALUES ('test-provider', ${DEFAULT_USER_ID}, NOW() - INTERVAL '1 day', 75, 18)
            ON CONFLICT DO NOTHING`,
      );

      // Insert a strength workout for strength frequency score
      const workoutDate = new Date();
      workoutDate.setDate(workoutDate.getDate() - 3);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.strength_workout
            (provider_id, user_id, external_id, started_at, name)
            VALUES ('test-provider', ${DEFAULT_USER_ID}, 'strength-1', ${workoutDate.toISOString()}, 'Test Workout')
            ON CONFLICT DO NOTHING`,
      );

      await refreshViews();
    }, 30_000);

    it("returns composite score with metric breakdowns", async () => {
      const { status, result } = await query("healthspan.score", {
        weeks: 4,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // Composite score should be 0-100
      expect(data.healthspanScore).toBeGreaterThanOrEqual(0);
      expect(data.healthspanScore).toBeLessThanOrEqual(100);

      // Should have 9 metric breakdowns
      expect(data.metrics).toHaveLength(9);

      for (const metric of data.metrics) {
        expect(metric.name).toBeTruthy();
        expect(metric.unit).toBeTruthy();
        expect(metric.score).toBeGreaterThanOrEqual(0);
        expect(metric.score).toBeLessThanOrEqual(100);
        expect(["excellent", "good", "fair", "poor"]).toContain(metric.status);
      }

      // With birth_date set, biological age should be calculated
      expect(data.chronologicalAge).toBeGreaterThan(30);
      expect(data.chronologicalAge).toBeLessThan(40);
      expect(data.biologicalAge).toBeDefined();
      expect(data.biologicalAge).not.toBeNull();
    });

    it("lean body mass is scored from body fat percentage", async () => {
      const { status, result } = await query("healthspan.score", {
        weeks: 4,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      const leanMassMetric = data.metrics.find(
        (m: { name: string }) => m.name === "Lean Body Mass",
      );
      expect(leanMassMetric).toBeDefined();
      // 18% body fat = 82% lean mass -> should score well
      expect(leanMassMetric.value).toBeCloseTo(82, 0);
      expect(leanMassMetric.score).toBeGreaterThanOrEqual(80);
    });

    it("resting HR score reflects inserted data", async () => {
      const { status, result } = await query("healthspan.score", {
        weeks: 4,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      const rhrMetric = data.metrics.find((m: { name: string }) => m.name === "Resting Heart Rate");
      expect(rhrMetric).toBeDefined();
      // Inserted resting_hr of 55-65, avg should be ~60
      if (rhrMetric.value !== null) {
        expect(rhrMetric.value).toBeGreaterThan(50);
        expect(rhrMetric.value).toBeLessThan(70);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Life Events — analyze compares metrics before/after
  // ══════════════════════════════════════════════════════════════
  describe("lifeEvents analyze", () => {
    let analyzeEventId: string;

    beforeAll(async () => {
      // Create a life event dated ~15 days ago
      const eventDate = new Date();
      eventDate.setDate(eventDate.getDate() - 15);
      const dateStr = eventDate.toISOString().slice(0, 10);

      const { result } = await mutate("lifeEvents.create", {
        label: "Started meditation",
        startedAt: dateStr,
        category: "wellness",
      });
      analyzeEventId = result.result.data.id;
    });

    it("returns before/after comparison with metrics", async () => {
      const { status, result } = await query("lifeEvents.analyze", {
        id: analyzeEventId,
        windowDays: 14,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data).toBeDefined();
      expect(data.event).toBeDefined();
      expect(data.metrics).toBeDefined();
      expect(data.sleep).toBeDefined();
      expect(data.bodyComp).toBeDefined();

      // Metrics should have 'before' and/or 'after' periods
      if (data.metrics.length > 0) {
        for (const period of data.metrics) {
          expect(["before", "after"]).toContain(period.period);
          expect(Number(period.days)).toBeGreaterThan(0);
        }
      }
    });

    afterAll(async () => {
      if (analyzeEventId) {
        await mutate("lifeEvents.delete", { id: analyzeEventId });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Cycling Advanced — ramp rate EWMA + recommendation
  // ══════════════════════════════════════════════════════════════
  describe("cyclingAdvanced rampRate", () => {
    it("computes ramp rate with EWMA and provides recommendation", async () => {
      // Data was already inserted in weeklyReport beforeAll (cycling activities with HR + power)
      const { status, result } = await query("cyclingAdvanced.rampRate", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(typeof data.currentRampRate).toBe("number");
      expect(typeof data.recommendation).toBe("string");
      expect(data.recommendation.length).toBeGreaterThan(0);
      expect(Array.isArray(data.weeks)).toBe(true);

      // Recommendation should be one of the three categories
      expect(
        data.recommendation.startsWith("Safe") ||
          data.recommendation.startsWith("Aggressive") ||
          data.recommendation.startsWith("Danger") ||
          data.recommendation === "No data",
      ).toBe(true);

      if (data.weeks.length > 0) {
        for (const week of data.weeks) {
          expect(week.week).toBeTruthy();
          expect(typeof week.ctlStart).toBe("number");
          expect(typeof week.ctlEnd).toBe("number");
          expect(typeof week.rampRate).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Efficiency — aerobic decoupling with power+HR data
  // ══════════════════════════════════════════════════════════════
  describe("efficiency aerobicDecoupling", () => {
    it("returns decoupling results when activities have power and HR", async () => {
      const { status, result } = await query("efficiency.aerobicDecoupling", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // Data might be empty if activities don't have enough samples (600+)
      expect(Array.isArray(data)).toBe(true);

      for (const row of data) {
        expect(row.date).toBeTruthy();
        expect(typeof row.firstHalfRatio).toBe("number");
        expect(typeof row.secondHalfRatio).toBe("number");
        expect(typeof row.decouplingPct).toBe("number");
        expect(row.totalSamples).toBeGreaterThanOrEqual(600);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Hiking — grade-adjusted pace with Minetti cost factor
  // ══════════════════════════════════════════════════════════════
  describe("hiking gradeAdjustedPace", () => {
    beforeAll(async () => {
      // Insert hiking activities with elevation data
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        const activityDate = new Date(now);
        activityDate.setDate(activityDate.getDate() - i * 7 - 1);
        const startedAt = new Date(activityDate);
        startedAt.setHours(9, 0, 0, 0);
        const endedAt = new Date(startedAt.getTime() + 90 * 60 * 1000); // 90 min

        const externalId = `hike-gap-${i}`;
        await testCtx.db.execute(
          sql`INSERT INTO fitness.activity
              (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
              VALUES ('test-provider', ${DEFAULT_USER_ID}, ${externalId}, 'hiking', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${`Mountain Hike ${i}`})
              ON CONFLICT DO NOTHING`,
        );

        const activityRows = await testCtx.db.execute(
          sql`SELECT id FROM fitness.activity WHERE external_id = ${externalId} AND provider_id = 'test-provider'`,
        );
        const activityId = (activityRows[0] as { id: string } | undefined)?.id;
        if (activityId) {
          // Insert metric_stream with altitude data for elevation calculations
          for (let minute = 0; minute < 90; minute++) {
            const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
            // Simulate climbing: altitude goes from 500m to 900m
            const altitude = 500 + (minute / 90) * 400;
            const speed = 1.2 + Math.random() * 0.3; // ~1.2-1.5 m/s
            const distance = minute * 60 * speed; // cumulative

            await testCtx.db.execute(
              sql`INSERT INTO fitness.metric_stream
                  (recorded_at, user_id, activity_id, provider_id, heart_rate, speed, altitude, distance, grade)
                  VALUES (${sampleTime.toISOString()}, ${DEFAULT_USER_ID}, ${activityId}::uuid, 'test-provider', ${130 + Math.round(Math.random() * 15)}, ${speed}, ${altitude}, ${distance}, ${5 + Math.random() * 3})`,
            );
          }
        }
      }

      await refreshViews();
    }, 60_000);

    it("computes grade-adjusted pace using Minetti cost factor", async () => {
      const { status, result } = await query("hiking.gradeAdjustedPace", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // We should have hiking activities from the insert above
      if (data.length > 0) {
        for (const row of data) {
          expect(row.activityType).toBe("hiking");
          expect(row.distanceKm).toBeGreaterThan(0);
          expect(row.durationMinutes).toBeGreaterThan(0);
          expect(row.averagePaceMinPerKm).toBeGreaterThan(0);
          // Grade-adjusted pace should be lower than actual pace for uphill
          // (dividing by costFactor > 1 for positive grade)
          expect(row.gradeAdjustedPaceMinPerKm).toBeGreaterThan(0);
          if (row.elevationGainMeters > 0) {
            expect(row.gradeAdjustedPaceMinPerKm).toBeLessThanOrEqual(row.averagePaceMinPerKm);
          }
        }
      }
    });

    it("elevation profile aggregates weekly", async () => {
      const { status, result } = await query("hiking.elevationProfile", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      if (data.length > 0) {
        for (const row of data) {
          expect(row.week).toBeTruthy();
          expect(typeof row.elevationGainMeters).toBe("number");
          expect(typeof row.activityCount).toBe("number");
          expect(row.activityCount).toBeGreaterThan(0);
          expect(typeof row.totalDistanceKm).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Hiking — activity comparison groups repeated routes
  // ══════════════════════════════════════════════════════════════
  describe("hiking activityComparison", () => {
    beforeAll(async () => {
      // Insert 2 activities with the same name for comparison
      const now = new Date();
      for (let i = 0; i < 2; i++) {
        const activityDate = new Date(now);
        activityDate.setDate(activityDate.getDate() - i * 14 - 1);
        const startedAt = new Date(activityDate);
        startedAt.setHours(10, 0, 0, 0);
        const endedAt = new Date(startedAt.getTime() + 75 * 60 * 1000);

        const externalId = `repeated-trail-${i}`;
        await testCtx.db.execute(
          sql`INSERT INTO fitness.activity
              (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
              VALUES ('test-provider', ${DEFAULT_USER_ID}, ${externalId}, 'hiking', ${startedAt.toISOString()}, ${endedAt.toISOString()}, 'Repeated Trail')
              ON CONFLICT DO NOTHING`,
        );

        const activityRows = await testCtx.db.execute(
          sql`SELECT id FROM fitness.activity WHERE external_id = ${externalId} AND provider_id = 'test-provider'`,
        );
        const activityId = (activityRows[0] as { id: string } | undefined)?.id;
        if (activityId) {
          for (let minute = 0; minute < 75; minute++) {
            const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
            const altitude = 300 + (minute / 75) * 200;
            const speed = 1.3 + Math.random() * 0.2;
            const distance = minute * 60 * speed;

            await testCtx.db.execute(
              sql`INSERT INTO fitness.metric_stream
                  (recorded_at, user_id, activity_id, provider_id, heart_rate, speed, altitude, distance, grade)
                  VALUES (${sampleTime.toISOString()}, ${DEFAULT_USER_ID}, ${activityId}::uuid, 'test-provider', ${125 + Math.round(Math.random() * 10)}, ${speed}, ${altitude}, ${distance}, ${3 + Math.random() * 2})`,
            );
          }
        }
      }

      await refreshViews();
    }, 60_000);

    it("groups repeated activities and returns comparison instances", async () => {
      const { status, result } = await query("hiking.activityComparison", {
        days: 365,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // Should find "Repeated Trail" with 2 instances
      const repeatedTrail = data.find(
        (r: { activityName: string }) => r.activityName === "Repeated Trail",
      );
      if (repeatedTrail) {
        expect(repeatedTrail.instances.length).toBeGreaterThanOrEqual(2);
        for (const instance of repeatedTrail.instances) {
          expect(instance.date).toBeTruthy();
          expect(typeof instance.durationMinutes).toBe("number");
          expect(typeof instance.averagePaceMinPerKm).toBe("number");
          expect(typeof instance.elevationGainMeters).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Intervals — detect from metric_stream
  // ══════════════════════════════════════════════════════════════
  describe("intervals detect", () => {
    let intervalActivityId: string;

    beforeAll(async () => {
      // Create an activity with distinct intensity changes for interval detection
      const now = new Date();
      const startedAt = new Date(now);
      startedAt.setDate(startedAt.getDate() - 2);
      startedAt.setHours(7, 0, 0, 0);
      const endedAt = new Date(startedAt.getTime() + 40 * 60 * 1000);

      await testCtx.db.execute(
        sql`INSERT INTO fitness.activity
            (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
            VALUES ('test-provider', ${DEFAULT_USER_ID}, 'interval-detect-1', 'cycling', ${startedAt.toISOString()}, ${endedAt.toISOString()}, 'Interval Workout')
            ON CONFLICT DO NOTHING`,
      );

      const activityRows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.activity WHERE external_id = 'interval-detect-1' AND provider_id = 'test-provider'`,
      );
      intervalActivityId = (activityRows[0] as { id: string }).id;

      // Insert metric_stream with alternating easy/hard segments
      // Easy: power ~150, Hard: power ~250 (>15% change)
      for (let minute = 0; minute < 40; minute++) {
        const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
        // Alternate every 5 minutes between easy and hard
        const isHard = Math.floor(minute / 5) % 2 === 1;
        const power = isHard
          ? 240 + Math.round(Math.random() * 20)
          : 140 + Math.round(Math.random() * 20);
        const hr = isHard
          ? 165 + Math.round(Math.random() * 10)
          : 130 + Math.round(Math.random() * 10);

        await testCtx.db.execute(
          sql`INSERT INTO fitness.metric_stream
              (recorded_at, user_id, activity_id, provider_id, heart_rate, power, speed)
              VALUES (${sampleTime.toISOString()}, ${DEFAULT_USER_ID}, ${intervalActivityId}::uuid, 'test-provider', ${hr}, ${power}, ${5.5 + Math.random()})`,
        );
      }
    }, 30_000);

    it("detects intervals from intensity changes", async () => {
      const { status, result } = await query("intervals.detect", {
        activityId: intervalActivityId,
      });
      expect(status).toBe(200);
      const intervals = result.result.data;

      expect(Array.isArray(intervals)).toBe(true);
      // With 5-min alternating segments over 40 min, we should detect multiple intervals
      // (at least 2, possibly more depending on exact random values)
      expect(intervals.length).toBeGreaterThanOrEqual(2);

      for (const interval of intervals) {
        expect(typeof interval.intervalIndex).toBe("number");
        expect(interval.startedAt).toBeTruthy();
        expect(interval.endedAt).toBeTruthy();
      }
    });

    it("byActivity returns stored intervals", async () => {
      // Insert an interval for the activity
      await testCtx.db.execute(
        sql`INSERT INTO fitness.activity_interval
            (activity_id, interval_index, label, started_at, ended_at, avg_power, avg_heart_rate, distance_meters)
            VALUES (${intervalActivityId}::uuid, 0, 'Warmup', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '50 minutes', 150, 130, 2000)`,
      );

      const { status, result } = await query("intervals.byActivity", {
        activityId: intervalActivityId,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].label).toBe("Warmup");
      expect(Number(data[0].avg_power)).toBe(150);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sport Settings — zone percentages (JSON storage)
  // ══════════════════════════════════════════════════════════════
  describe("sportSettings zones", () => {
    it("stores and retrieves JSON zone percentages", async () => {
      const powerZones = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
      const { status: upsertStatus } = await mutate("sportSettings.upsert", {
        sport: "running",
        thresholdHr: 175,
        thresholdPacePerKm: 4.5,
        hrZonePcts: [0.6, 0.7, 0.8, 0.9, 1.0],
        paceZonePcts: powerZones,
        effectiveFrom: "2025-03-01",
      });
      expect(upsertStatus).toBe(200);

      const { result: getResult } = await query("sportSettings.getBySport", {
        sport: "running",
        asOfDate: "2025-03-15",
      });
      const settings = getResult.result.data;
      expect(settings.threshold_hr).toBe(175);
      expect(settings.threshold_pace_per_km).toBeCloseTo(4.5);
      expect(settings.hr_zone_pcts).toEqual([0.6, 0.7, 0.8, 0.9, 1.0]);
      expect(settings.pace_zone_pcts).toEqual(powerZones);
    });
  });
});
