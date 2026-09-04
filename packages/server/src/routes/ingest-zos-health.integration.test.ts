import { sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import { generateCompanionToken, hashCompanionToken } from "../companion/token-repository.ts";

const { createIngestZosHealthRouter } = await import("./ingest-zos-health.ts");

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server address is null or string");
  return addr.port;
}

async function post(
  app: express.Express,
  path: string,
  opts: { headers?: Record<string, string>; body: unknown; rawBody?: boolean },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      const transportBody = opts.rawBody
        ? opts.body
        : {
            version: 1,
            batchId: "batch-integration",
            source: { connectionType: "zepp", installId: "install-integration" },
            events: [
              {
                eventId: "event-integration",
                createdAt: "2024-07-03T10:48:20.000Z",
                payload: opts.body,
              },
            ],
          };
      fetch(`http://localhost:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opts.headers },
        body: JSON.stringify(transportBody),
      })
        .then(async (res) => {
          resolve({ status: res.status, body: await res.text() });
          server.close();
        })
        .catch((_error: unknown) => {
          resolve({ status: 500, body: "fetch error" });
          server.close();
        });
    });
  });
}

function expectAccepted(response: { status: number; body: string }): void {
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({
    status: "ok",
    acceptedEventIds: ["event-integration"],
    rejected: [],
  });
}

describe("POST /api/ingest/zos-health", () => {
  let testCtx: TestContext;
  let app: express.Express;
  let validToken: string;
  let publishedMetricRows: MetricStreamRowInput[] = [];

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    validToken = generateCompanionToken();
    const hash = hashCompanionToken(validToken);
    await testCtx.db.execute(sql`
      INSERT INTO fitness.companion_token (user_id, token_hash)
      VALUES (${TEST_USER_ID}, ${hash})
    `);

    app = express();
    app.use(
      "/api/ingest",
      createIngestZosHealthRouter({
        db: testCtx.db,
        metricStreamPublisher: {
          publishRows: async (rows) => {
            publishedMetricRows.push(...rows);
            return [];
          },
        },
      }),
    );
  });

  beforeEach(async () => {
    publishedMetricRows = [];
    await testCtx.db.execute(
      sql`DELETE FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID}`,
    );
    await testCtx.db.execute(
      sql`DELETE FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID}`,
    );
    await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`);
  });

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  // ── Auth guard tests ──

  it("returns 401 when no auth header is provided", async () => {
    const res = await post(app, "/api/ingest/zos-health", { body: {} });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Dofek connection is required." });
  });

  it("returns 401 when auth header has no Bearer token", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "no-bearer" },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Dofek connection is required." });
  });

  it("returns 401 when auth header has empty Bearer token", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer " },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Dofek connection is required." });
  });

  it("returns 401 when companion token is invalid", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer invalid-token" },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid or revoked Dofek connection." });
  });

  // ── Payload validation tests ──

  it("rejects an event when its payload fails schema validation", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: { dailyMetrics: "not-an-object" },
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.acceptedEventIds).toEqual([]);
    expect(parsed.rejected).toEqual([
      expect.objectContaining({
        eventId: "event-integration",
        issues: [expect.objectContaining({ path: "dailyMetrics" })],
      }),
    ]);
  });

  it("rejects an event when its payload has no data sections", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      acceptedEventIds: [],
      rejected: [{ eventId: "event-integration" }],
    });
  });

  // ── Daily metrics tests ──

  it("returns 200 and processes dailyMetrics with all fields", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2026-06-26": {
            steps: 10000,
            distanceKm: 8.5,
            standHours: 12,
            spo2Avg: 97.5,
            skinTempC: 36.5,
            stressHighMinutes: 30,
            exerciseMinutes: 45,
          },
        },
      },
    });
    expectAccepted(res);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].steps).toBe(10000);
    expect(rows[0].distance_km).toBe(8.5);
    expect(rows[0].stand_hours).toBe(12);
    expect(rows[0].spo2_avg).toBe(97.5);
    expect(rows[0].skin_temp_c).toBe(36.5);
    expect(rows[0].stress_high_minutes).toBe(30);
    expect(rows[0].exercise_minutes).toBe(45);
  });

  it("returns 200 and processes dailyMetrics with partial fields", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2026-06-25": { steps: 8000 },
        },
      },
    });
    expectAccepted(res);

    const rows = await testCtx.db.execute(
      sql`SELECT steps FROM fitness.daily_metrics WHERE date = '2026-06-25' AND user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].steps).toBe(8000);
  });

  it("keeps canonical rows idempotent when the same event is replayed", async () => {
    const request = {
      headers: { Authorization: `Bearer ${validToken}` },
      body: { dailyMetrics: { "2026-06-24": { steps: 7000 } } },
    };

    const first = await post(app, "/api/ingest/zos-health", request);
    const replay = await post(app, "/api/ingest/zos-health", request);

    expectAccepted(first);
    expectAccepted(replay);
    const rows = await testCtx.db.execute(
      sql`SELECT steps FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID} AND date = '2026-06-24'`,
    );
    expect(rows).toEqual([expect.objectContaining({ steps: 7000 })]);
  });

  it("stores daily totals from the raw watch summary", async () => {
    const response = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        watchSummary: {
          collectedAt: 1_720_001_200_000,
          date: "2024-07-03",
          timezoneOffsetMinutes: 0,
          steps: 4321,
          standHours: 8,
          fatBurning: 22,
        },
      },
    });

    expect(response.status).toBe(200);
    const rows = await testCtx.db.execute(
      sql`SELECT steps, stand_hours, exercise_minutes
          FROM fitness.daily_metrics
          WHERE date = '2024-07-03' AND user_id = ${TEST_USER_ID}`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        steps: 4321,
        stand_hours: 8,
        exercise_minutes: 22,
      }),
    ]);
  });

  it("preserves daily metric fields omitted from the watch summary", async () => {
    const response = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2024-07-04": { distanceKm: 7.5, standHours: 10 },
        },
        watchSummary: {
          collectedAt: 1_720_087_600_000,
          date: "2024-07-04",
          timezoneOffsetMinutes: 0,
          steps: 5432,
        },
      },
    });

    expect(response.status).toBe(200);
    const rows = await testCtx.db.execute(
      sql`SELECT steps, distance_km, stand_hours
          FROM fitness.daily_metrics
          WHERE date = '2024-07-04' AND user_id = ${TEST_USER_ID}`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        steps: 5432,
        distance_km: 7.5,
        stand_hours: 10,
      }),
    ]);
  });

  it("skips dailyMetrics with invalid date key", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "not-a-date": { steps: 10000 },
        },
      },
    });
    expectAccepted(res);
  });

  // ── Sleep session tests ──

  it("returns 200 and processes sleepSessions with stages", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-1",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            durationMinutes: 480,
            stages: [
              { stage: "deep", startedAt: "2026-06-26T23:00:00Z", endedAt: "2026-06-27T00:00:00Z" },
              { stage: "rem", startedAt: "2026-06-27T04:00:00Z", endedAt: "2026-06-27T05:00:00Z" },
            ],
          },
        ],
      },
    });
    expectAccepted(res);

    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0].external_id).toBe("sleep-1");

    const stages = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_stage WHERE session_id = ${sessions[0].id}`,
    );
    expect(stages.length).toBe(2);
  });

  it("rejects sleep session with invalid dates at schema validation", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "bad-sleep",
            startedAt: "not-a-date",
            endedAt: "also-not-a-date",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ acceptedEventIds: [] });
  });

  it("fetches existing sleep session when insert conflicts", async () => {
    // First insert creates the session
    const res1 = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "dup-sleep",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              { stage: "deep", startedAt: "2026-06-26T23:00:00Z", endedAt: "2026-06-27T00:00:00Z" },
            ],
          },
        ],
      },
    });
    expect(res1.status).toBe(200);

    // Second insert with same externalId triggers conflict — should still succeed
    // and attach stages to the existing session
    const res2 = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "dup-sleep",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              { stage: "rem", startedAt: "2026-06-27T04:00:00Z", endedAt: "2026-06-27T05:00:00Z" },
            ],
          },
        ],
      },
    });
    expect(res2.status).toBe(200);
    expectAccepted(res2);

    // Exactly one session row
    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID} AND external_id = 'dup-sleep'`,
    );
    expect(sessions.length).toBe(1);

    // Both stages should be present (from first and second upload)
    const stages = await testCtx.db.execute(
      sql`SELECT stage FROM fitness.sleep_stage WHERE session_id = ${sessions[0].id} ORDER BY started_at`,
    );
    expect(stages.length).toBe(2);
    expect(stages.map((r: { stage: string }) => r.stage).sort()).toEqual(["deep", "rem"]);
  });

  it("rejects sleep stage with invalid dates at schema validation", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-stages",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [{ stage: "deep", startedAt: "bad-date", endedAt: "2026-06-27T00:00:00Z" }],
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ acceptedEventIds: [] });
  });

  // ── Activity tests ──

  it("returns 200 and processes activities", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-1",
            activityType: "running",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00Z",
            name: "Morning Run",
          },
        ],
      },
    });
    expectAccepted(res);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
  });

  it("merges retry-safe live snapshots and extends an existing activity", async () => {
    const firstRecordedAt = "2026-06-26T10:05:00.000Z";
    const secondRecordedAt = "2026-06-26T10:06:00.000Z";
    for (const [recordedAt, endedAt, heartRate, rawMetadata] of [
      [firstRecordedAt, "2026-06-26T10:05:00Z", 140, { device: { model: "Balance" } }],
      [secondRecordedAt, "2026-06-26T10:06:00Z", 145, { workout: { source: "extension" } }],
    ] as const) {
      const response = await post(app, "/api/ingest/zos-health", {
        headers: { Authorization: `Bearer ${validToken}` },
        body: {
          activities: [
            {
              externalId: "live-act-1",
              activityType: "other",
              startedAt: "2026-06-26T10:00:00Z",
              endedAt,
              raw: {
                ...rawMetadata,
                liveSnapshotsByRecordedAt: {
                  [recordedAt]: { recordedAt, heartRate },
                },
              },
            },
          ],
        },
      });
      expect(response.status).toBe(200);
    }

    const rows = await testCtx.db.execute(sql`
      SELECT ended_at::text AS ended_at, raw
      FROM fitness.activity
      WHERE user_id = ${TEST_USER_ID} AND external_id = 'live-act-1'
    `);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.ended_at)).toContain("2026-06-26 10:06:00");
    expect(rows[0]?.raw).toEqual({
      device: { model: "Balance" },
      workout: { source: "extension" },
      liveSnapshotsByRecordedAt: {
        [firstRecordedAt]: { recordedAt: firstRecordedAt, heartRate: 140 },
        [secondRecordedAt]: { recordedAt: secondRecordedAt, heartRate: 145 },
      },
    });
  });

  it("resolves repeated live workout samples through the batched activity lookup", async () => {
    const externalId = "live-array-serialization";
    const response = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId,
            activityType: "other",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T10:10:00Z",
          },
        ],
        liveWorkoutSamples: [
          {
            externalId,
            recordedAt: "2026-06-26T10:05:00.000Z",
            heartRate: 140,
            metrics: { duration: 300 },
          },
          {
            externalId,
            recordedAt: "2026-06-26T10:06:00.000Z",
            metrics: { duration: 360 },
          },
        ],
      },
    });

    expect(response.status).toBe(200);
    const activityRows = await testCtx.db.execute(sql`
      SELECT id::text AS id
      FROM fitness.activity
      WHERE user_id = ${TEST_USER_ID} AND external_id = ${externalId}
    `);
    expect(activityRows).toHaveLength(1);
    const activityId = String(activityRows[0]?.id);
    expect(publishedMetricRows).toHaveLength(3);
    expect(new Set(publishedMetricRows.map((row) => row.activityId))).toEqual(
      new Set([activityId]),
    );
  });

  it("rejects activity with invalid dates at schema validation", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "bad-act",
            activityType: "running",
            startedAt: "not-valid",
            endedAt: "also-not-valid",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ acceptedEventIds: [] });
  });

  // ── Combined payload tests ──

  it("returns 200 with all data sections combined", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 10000, calories: 500 },
        },
        sleepSessions: [
          {
            externalId: "sleep-combined",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
        activities: [
          {
            externalId: "act-combined",
            activityType: "cycling",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00Z",
          },
        ],
      },
    });
    expectAccepted(res);
  });

  // ── Multi-entry tests ──

  it("returns 200 with multiple daily metrics dates", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2026-06-25": { steps: 8000 },
          "2026-06-26": { steps: 10000 },
          "2026-06-27": { steps: 12000 },
        },
      },
    });
    expectAccepted(res);

    const rows = await testCtx.db.execute(
      sql`SELECT date, steps FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID} ORDER BY date`,
    );
    expect(rows.length).toBe(3);
  });

  it("returns 200 with multiple sleep sessions", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-a",
            startedAt: "2026-06-25T22:00:00Z",
            endedAt: "2026-06-26T06:00:00Z",
          },
          {
            externalId: "sleep-b",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expectAccepted(res);
  });

  it("returns 200 with multiple activities", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-a",
            activityType: "running",
            startedAt: "2026-06-25T10:00:00Z",
            endedAt: "2026-06-25T11:00:00Z",
          },
          {
            externalId: "act-b",
            activityType: "cycling",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00Z",
          },
        ],
      },
    });
    expectAccepted(res);
  });

  it("processes sleep sessions without stages", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-no-stages",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            durationMinutes: 480,
          },
        ],
      },
    });
    expectAccepted(res);
  });

  it("processes activities without name", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-no-name",
            activityType: "running",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00Z",
          },
        ],
      },
    });
    expectAccepted(res);
  });

  // ── Mutation-killing: daily metrics SQL guard ──

  it("stores daily metrics when dailyMetrics is provided", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: { "2026-06-26": { steps: 5000 } },
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT steps FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID} AND date = '2026-06-26'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].steps).toBe(5000);
  });

  it("does not store daily metrics when only sleepSessions provided", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-no-metrics",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(0);
  });

  it("stores daily metrics only for valid date keys", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 9000 },
          "not-a-valid-date": { steps: 1000 },
        },
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT date, steps FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].steps).toBe(9000);
  });

  it("stores no daily metrics when all date keys are invalid", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "not-a-date": { steps: 1000 },
          "also-not-a-date": { steps: 2000 },
        },
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(0);
  });

  // ── Mutation-killing: activity guards ──

  it("stores activities when activities are provided", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-exec-check",
            activityType: "running",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
  });

  it("does not store activities when no activities in payload", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-no-act",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(0);
  });

  // ── Mutation-killing: SQL interpolation value fidelity ──

  it("stores each daily metric field value correctly in the database", async () => {
    await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        dailyMetrics: {
          "2026-06-26": {
            steps: 12345,
            distanceKm: 12.34,
            standHours: 7,
            spo2Avg: 96.5,
            skinTempC: 35.4,
            stressHighMinutes: 22,
            exerciseMinutes: 33,
          },
        },
      },
    });

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.daily_metrics WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.steps).toBe(12345);
    expect(Number(row.distance_km)).toBeCloseTo(12.34);
    expect(row.stand_hours).toBe(7);
    expect(Number(row.spo2_avg)).toBeCloseTo(96.5);
    expect(Number(row.skin_temp_c)).toBeCloseTo(35.4);
    expect(row.stress_high_minutes).toBe(22);
    expect(row.exercise_minutes).toBe(33);
  });

  it("stores activity name correctly when provided", async () => {
    await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-named",
            activityType: "running",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00Z",
            name: "Sunrise Long Run",
          },
        ],
      },
    });

    const rows = await testCtx.db.execute(
      sql`SELECT name FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Sunrise Long Run");
  });

  // ── Mutation-killing: NaN-date defensive guards ──
  // The ingest schema accepts pathological offsets like "+99:00", but new Date()
  // rejects them with Invalid Date (NaN from .getTime()). The route warns and skips.

  it("skips sleep session whose Zod-valid offset produces an Invalid Date", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-bad-offset",
            startedAt: "2026-06-26T22:00:00+99:00",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    // Session was skipped — no sleep_session row stored
    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(sessions.length).toBe(0);
  });

  it("skips sleep session when only one date is NaN", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-one-bad",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00+99:00",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(sessions.length).toBe(0);
  });

  it("skips sleep stage whose Zod-valid offset produces an Invalid Date", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-stage-bad-offset",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              {
                stage: "deep",
                startedAt: "2026-06-26T23:00:00+99:00",
                endedAt: "2026-06-27T00:00:00Z",
              },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    // Session is stored but stage is skipped
    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(sessions.length).toBe(1);

    const stages = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_stage WHERE session_id = ${sessions[0].id}`,
    );
    expect(stages.length).toBe(0);
  });

  it("skips sleep stage when only one stage date is NaN", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-stage-one-bad",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              {
                stage: "rem",
                startedAt: "2026-06-27T04:00:00Z",
                endedAt: "2026-06-27T05:00:00+99:00",
              },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(sessions.length).toBe(1);

    const stages = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_stage WHERE session_id = ${sessions[0].id}`,
    );
    expect(stages.length).toBe(0);
  });

  it("skips activity whose Zod-valid offset produces an Invalid Date", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-bad-offset",
            activityType: "running",
            startedAt: "2026-06-26T10:00:00+99:00",
            endedAt: "2026-06-26T11:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(0);
  });

  it("skips activity when only one activity date is NaN", async () => {
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        activities: [
          {
            externalId: "act-one-bad",
            activityType: "running",
            startedAt: "2026-06-26T10:00:00Z",
            endedAt: "2026-06-26T11:00:00+99:00",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(rows.length).toBe(0);
  });

  // ── Mutation-killing: conflict behavior ──

  it("does not create duplicate sleep session when externalId conflicts", async () => {
    // Insert same session twice
    await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "dedup-sleep",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "dedup-sleep",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });

    const sessions = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID} AND external_id = 'dedup-sleep'`,
    );
    expect(sessions.length).toBe(1);
  });

  it("stores sleep session with correct optional field values", async () => {
    await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: `Bearer ${validToken}` },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-all-opts",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            durationMinutes: 480,
            deepMinutes: 90,
            remMinutes: 120,
            lightMinutes: 240,
            awakeMinutes: 30,
            efficiencyPct: 87.5,
          },
        ],
      },
    });

    const rows = await testCtx.db.execute(
      sql`SELECT * FROM fitness.sleep_session WHERE user_id = ${TEST_USER_ID} AND external_id = 'sleep-all-opts'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].duration_minutes).toBe(480);
    expect(rows[0].deep_minutes).toBe(90);
    expect(rows[0].rem_minutes).toBe(120);
    expect(rows[0].light_minutes).toBe(240);
    expect(rows[0].awake_minutes).toBe(30);
    expect(rows[0].staging_available).toBe(true);
    expect(Number(rows[0].efficiency_pct)).toBeCloseTo(87.5);
  });
});
