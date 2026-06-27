import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";

const { createIngestZosHealthRouter } = await import("./ingest-zos-health.ts");

interface CapturedSql {
  sql: string;
}

function createFakeDb(): import("dofek/db").Database & { captured: CapturedSql[] } {
  const captured: CapturedSql[] = [];
  return {
    captured,
    execute: vi.fn(async (sqlQuery: unknown) => {
      captured.push({ sql: String(sqlQuery) });
      return [];
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 1 }]),
        })),
      })),
    })),
  } satisfies import("dofek/db").Database & { captured: CapturedSql[] };
}

function createFakeDbWithSleepConflict(): import("dofek/db").Database & {
  captured: CapturedSql[];
  insertMock: ReturnType<typeof vi.fn>;
} {
  const captured: CapturedSql[] = [];
  const returningMock = vi.fn(async () => []);
  const onConflictDoNothingMock = vi.fn(() => ({ returning: returningMock }));
  const valuesMock = vi.fn(() => ({ onConflictDoNothing: onConflictDoNothingMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  let executeCallCount = 0;

  return {
    captured,
    insertMock,
    execute: vi.fn(async (sqlQuery: unknown) => {
      captured.push({ sql: String(sqlQuery) });
      executeCallCount++;
      // The second execute call (0-indexed: index 1) is the sleep session SELECT.
      // The first call is the provider INSERT whose result is unused.
      if (executeCallCount === 2) {
        return [{ id: "existing-session-id" }];
      }
      return [];
    }),
    insert: insertMock,
  } satisfies import("dofek/db").Database & {
    captured: CapturedSql[];
    insertMock: ReturnType<typeof vi.fn>;
  };
}

function createFakeDbCapturingSleepValues(): {
  db: import("dofek/db").Database;
  sleepInsertValues: unknown[];
} {
  const sleepInsertValues: unknown[] = [];
  const returningMock = vi.fn(async () => [{ id: "captured-session-id" }]);
  const onConflictDoNothingMock = vi.fn(() => ({ returning: returningMock }));
  const valuesMock = vi.fn((vals: unknown) => {
    sleepInsertValues.push(vals);
    return { onConflictDoNothing: onConflictDoNothingMock };
  });
  const insertMock = vi.fn(() => ({ values: valuesMock }));

  return {
    sleepInsertValues,
    db: {
      execute: vi.fn(async () => []),
      insert: insertMock,
    } satisfies import("dofek/db").Database,
  };
}

function createFakeDbThatThrows(): import("dofek/db").Database {
  return {
    execute: vi.fn(async () => {
      throw new Error("DB connection failed");
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            throw new Error("DB connection failed");
          }),
        })),
      })),
    })),
  } satisfies import("dofek/db").Database;
}

// Mock token validation
vi.mock("../companion/token-repository.ts", () => ({
  validateCompanionToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === "valid-token") return "test-user-id";
    if (token === "x") return "test-user-id";
    if (token === "throws") throw new Error("Token validation DB error");
    return null;
  }),
}));

function createTestApp(fakeDb?: import("dofek/db").Database) {
  const app = express();
  app.use("/api/ingest", createIngestZosHealthRouter({ db: fakeDb ?? createFakeDb() }));
  return { app };
}

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const addr: AddressInfo | null = server.address() satisfies AddressInfo | null;
  if (!addr) throw new Error("Server address is null");
  return addr.port;
}

async function post(
  app: express.Express,
  path: string,
  opts: { headers?: Record<string, string>; body: unknown },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...opts.headers },
        body: JSON.stringify(opts.body),
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

afterAll(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ingest/zos-health", () => {
  // ── Auth guard tests ──

  it("returns 401 when no auth header is provided", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", { body: {} });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Companion token is required." });
  });

  it("returns 401 when auth header has no Bearer token", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "no-bearer" },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Companion token is required." });
  });

  it("returns 401 when auth header has empty Bearer token", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer " },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Companion token is required." });
  });

  it("accepts a single-character Bearer token", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer x" },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 10000, calories: 500 },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns 401 when companion token is invalid", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer invalid-token" },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid or revoked companion token." });
  });

  it("returns 500 when token validation throws", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer throws" },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 10000 },
        },
      },
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Failed to validate companion token." });
  });

  // ── Payload validation tests ──

  it("returns 400 when payload fails schema validation", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: { dailyMetrics: "not-an-object" },
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("Invalid payload");
    expect(parsed.details).toBeDefined();
  });

  it("returns 400 when payload has no data sections", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {},
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "At least one of dailyMetrics, sleepSessions, or activities is required.",
    });
  });

  // ── Daily metrics tests ──

  it("returns 200 and processes dailyMetrics with all fields", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-26": {
            steps: 10000,
            calories: 500,
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns 200 and processes dailyMetrics with partial fields", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 10000 },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(db.captured.length).toBeGreaterThanOrEqual(1);
  });

  it("skips dailyMetrics with invalid date key", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "not-a-date": { steps: 10000 },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  // ── Sleep session tests ──

  it("returns 200 and processes sleepSessions with stages", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("rejects sleep session with invalid dates at schema validation", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(400);
  });

  it("fetches existing sleep session when insert conflicts", async () => {
    const db = createFakeDbWithSleepConflict();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "existing-sleep",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              { stage: "deep", startedAt: "2026-06-26T23:00:00Z", endedAt: "2026-06-27T00:00:00Z" },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("rejects sleep stage with invalid dates at schema validation", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(400);
  });

  // ── Activity tests ──

  it("returns 200 and processes activities", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("rejects activity with invalid dates at schema validation", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(400);
  });

  // ── Error handling ──

  it("returns 500 when DB throws", async () => {
    const { app } = createTestApp(createFakeDbThatThrows());
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 10000 },
        },
      },
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Failed to ingest health data." });
  });

  // ── Combined payload tests ──

  it("returns 200 with all data sections combined", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  // ── Multi-entry tests ──

  it("returns 200 with multiple daily metrics dates", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-25": { steps: 8000 },
          "2026-06-26": { steps: 10000 },
          "2026-06-27": { steps: 12000 },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns 200 with multiple sleep sessions", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns 200 with multiple activities", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("processes sleep sessions without stages", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("processes activities without name", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  // ── Mutation-killing: block entry guards ──

  it("executes daily metrics SQL when dailyMetrics is provided", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: { "2026-06-26": { steps: 5000 } },
      },
    });
    expect(res.status).toBe(200);
    // Provider insert + daily_metrics insert = at least 2 execute calls
    expect(vi.mocked(db.execute).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not execute daily metrics SQL when only sleepSessions provided", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // Provider insert + sleep SELECT = 2 calls, no daily_metrics insert
    const executeCalls = vi.mocked(db.execute).mock.calls.length;
    expect(executeCalls).toBeLessThan(3);
  });

  it("executes daily metrics only for valid date keys", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 9000 },
          "not-a-valid-date": { steps: 1000 },
        },
      },
    });
    expect(res.status).toBe(200);
    // Provider insert + exactly 1 valid daily_metrics insert (invalid date skipped)
    expect(vi.mocked(db.execute).mock.calls.length).toBe(2);
  });

  it("executes only provider insert when all daily metrics dates are invalid", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "not-a-date": { steps: 1000 },
          "also-not-a-date": { steps: 2000 },
        },
      },
    });
    expect(res.status).toBe(200);
    // Only provider insert — invalid dates are all skipped
    expect(vi.mocked(db.execute).mock.calls.length).toBe(1);
  });

  it("calls insert when sleep sessions are provided", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-insert-check",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalled();
  });

  it("does not call insert when no sleep sessions in payload", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: { "2026-06-26": { steps: 5000 } },
      },
    });
    expect(res.status).toBe(200);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("inserts sleep stages when stages and session id are available", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-with-stage",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              {
                stage: "deep",
                startedAt: "2026-06-26T23:00:00Z",
                endedAt: "2026-06-27T00:00:00Z",
              },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    // insert called twice: once for sleepSession, once for sleepStage
    expect(vi.mocked(db.insert).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not insert stages when session has no stages", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-no-stages",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    // Only 1 insert: for sleepSession itself (no stage inserts)
    expect(vi.mocked(db.insert).mock.calls.length).toBe(1);
  });

  it("inserts sleep session with correct optional field values", async () => {
    const { db, sleepInsertValues } = createFakeDbCapturingSleepValues();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);
    expect(sleepInsertValues[0]).toMatchObject({
      durationMinutes: 480,
      deepMinutes: 90,
      remMinutes: 120,
      lightMinutes: 240,
      awakeMinutes: 30,
      efficiencyPct: 87.5,
    });
  });

  it("uses existing session id from SELECT when insert conflicts and inserts stages", async () => {
    const db = createFakeDbWithSleepConflict();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "conflict-with-stages",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
            stages: [
              {
                stage: "rem",
                startedAt: "2026-06-27T04:00:00Z",
                endedAt: "2026-06-27T05:00:00Z",
              },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    // insert called twice: sleepSession (returns [] on conflict) + sleepStage (using existingId)
    expect(db.insertMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("executes activity SQL when activities are provided", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // Provider insert + activity insert = at least 2 execute calls
    expect(vi.mocked(db.execute).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not execute activity SQL when no activities in payload", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // No activity SQL: only provider insert + sleep SELECT
    const callCount = vi.mocked(db.execute).mock.calls.length;
    expect(callCount).toBeLessThanOrEqual(2);
  });
});
