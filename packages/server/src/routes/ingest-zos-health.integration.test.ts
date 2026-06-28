import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

/** Parse a drizzle `sql` template object and return its interpolated parameter values. */
const sqlObjectSchema = z.object({ queryChunks: z.array(z.unknown()) });

function extractSqlParams(sqlStmt: unknown): unknown[] {
  const parsed = sqlObjectSchema.safeParse(sqlStmt);
  if (!parsed.success) return [];
  const params: unknown[] = [];
  for (const chunk of parsed.data.queryChunks) {
    if (chunk !== null && typeof chunk === "object" && "value" in chunk) continue;
    params.push(chunk);
  }
  return params;
}

/** Zod schemas used to narrow mock call args captured via the chain helper. */
const externalIdValuesSchema = z.object({ externalId: z.unknown() });
const sessionIdValuesSchema = z.object({ sessionId: z.unknown() });
const stageValuesSchema = z.object({
  sessionId: z.unknown(),
  stage: z.string(),
  sourceName: z.string(),
  startedAt: z.instanceof(Date),
  endedAt: z.instanceof(Date),
});
const onConflictTargetSchema = z.object({ target: z.array(z.unknown()) });
const returningWithIdSchema = z.object({ id: z.unknown() });

interface InsertChainCall {
  table: unknown;
  valuesArg: unknown;
  onConflictArg: unknown;
  returningArg?: unknown;
  returningRows?: unknown[];
}

interface InsertChainsDbOptions {
  /** What each `db.execute()` call returns, indexed by call order. */
  executeReturnByCall?: unknown[];
  /** Rows returned by the sleep session `.returning(...)` call. */
  sessionReturningRows?: unknown[];
  /** When true, the SECOND `db.execute()` call returns `undefined` instead of an array. */
  undefinedSecondExecute?: boolean;
}

/**
 * Builds a fake db that captures every `insert(...).values(...).onConflictDoNothing(...)`
 * chain, recording each chain's args at the `onConflictDoNothing` step (so stage
 * inserts — which never call `.returning()` — are also captured). The chain's
 * `.returning(arg)` later populates `returningArg` on the captured entry.
 *
 * The first execute is the provider INSERT (unused result); the second is the sleep
 * session SELECT used to look up an existing id when the insert conflicts. By
 * default the session insert returns a single row — set `sessionReturningRows: []`
 * to model a conflict (so the SELECT row is used instead).
 */
function createFakeDbCapturingInsertChains(options: InsertChainsDbOptions = {}): {
  db: import("dofek/db").Database;
  inserts: InsertChainCall[];
} {
  const inserts: InsertChainCall[] = [];
  const sessionRows = options.sessionReturningRows ?? [{ id: "inserted-session" }];
  let executeCallCount = 0;
  const executeSpy = vi.fn(async () => {
    const callIndex = executeCallCount;
    executeCallCount += 1;
    if (options.undefinedSecondExecute && callIndex === 1) return undefined;
    const value = options.executeReturnByCall?.[callIndex];
    return value === undefined ? [] : value;
  });

  let lastTable: unknown = null;
  const insertMock = vi.fn((table: unknown) => {
    lastTable = table;
    return {
      values: vi.fn((valuesArg: unknown) => ({
        onConflictDoNothing: vi.fn((onConflictArg: unknown) => {
          const chain: InsertChainCall = {
            table: lastTable,
            valuesArg,
            onConflictArg,
          };
          inserts.push(chain);
          return {
            returning: vi.fn(async (returningArg: unknown) => {
              chain.returningArg = returningArg;
              chain.returningRows = sessionRows;
              return sessionRows;
            }),
          };
        }),
      })),
    };
  });

  return {
    db: { execute: executeSpy, insert: insertMock } satisfies import("dofek/db").Database,
    inserts,
  };
}

function findInsertWithExternalId(inserts: InsertChainCall[]): InsertChainCall | undefined {
  return inserts.find((chain) => externalIdValuesSchema.safeParse(chain.valuesArg).success);
}

function findInsertWithSessionId(inserts: InsertChainCall[]): InsertChainCall | undefined {
  return inserts.find((chain) => sessionIdValuesSchema.safeParse(chain.valuesArg).success);
}

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

  // ── Mutation-killing: SQL interpolation value fidelity ──

  it("interpolates each daily metric field value into the captured SQL params", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-26": {
            steps: 12345,
            calories: 678.9,
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
    expect(res.status).toBe(200);

    // db.execute is called twice: provider INSERT (call 0) + daily_metrics INSERT (call 1).
    const executeCalls = vi.mocked(db.execute).mock.calls;
    expect(executeCalls.length).toBe(2);
    const dailyMetricsParams = extractSqlParams(executeCalls[1][0]);
    expect(dailyMetricsParams).toEqual(
      expect.arrayContaining([12345, 678.9, 12.34, 7, 96.5, 35.4, 22, 33]),
    );
  });

  it("interpolates activity name into the activity INSERT SQL params when present", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(res.status).toBe(200);

    const executeCalls = vi.mocked(db.execute).mock.calls;
    expect(executeCalls.length).toBe(2);
    const activityParams = extractSqlParams(executeCalls[1][0]);
    expect(activityParams).toEqual(expect.arrayContaining(["Sunrise Long Run"]));
  });

  // ── Mutation-killing: NaN-date defensive guards ──
  // The schema uses `z.string().datetime({ offset: true })` which accepts
  // pathological offsets (`+99:00`) that Zod passes but `new Date(...)` rejects
  // with Invalid Date (NaNgetTime). The route warns and skips those records.
  // These tests assert the skip path — removing the guard or flipping `||`
  // to `&&` makes the mutant try to insert NaN dates and the request errors,
  // which the assertion catches.

  it("skips sleep session whose Zod-valid offset produces an Invalid Date", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // Session was skipped: sleep SELECT (the 2nd execute call) never ran.
    expect(vi.mocked(db.execute).mock.calls.length).toBe(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips sleep session when only one date is NaN (LogicalOperator `||` guard)", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // Mutating `||` to `&&` would not skip when one date is valid:
    // the route would attempt to insert with a NaN `endedAt`, throwing during
    // drizzle param interpolation, and the response would be 500 instead.
    expect(vi.mocked(db.execute).mock.calls.length).toBe(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("skips sleep stage whose Zod-valid offset produces an Invalid Date", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // The session is inserted (1 insert) but the stage is skipped — only 1 insert call.
    expect(vi.mocked(db.insert).mock.calls.length).toBe(1);
  });

  it("skips sleep stage when only one stage date is NaN (LogicalOperator `||` guard)", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // Stage session insert only — no stage insert because one date is NaN.
    expect(vi.mocked(db.insert).mock.calls.length).toBe(1);
  });

  it("skips activity whose Zod-valid offset produces an Invalid Date", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    // Only provider insert ran; activity was skipped.
    expect(vi.mocked(db.execute).mock.calls.length).toBe(1);
  });

  it("skips activity when only one activity date is NaN (LogicalOperator `||` guard)", async () => {
    const db = createFakeDb();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
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
    expect(vi.mocked(db.execute).mock.calls.length).toBe(1);
  });

  // ── Mutation-killing: sleep session insert chain args ──

  it("passes a 3-element target array onConflictDoNothing for sleep session insert", async () => {
    const { db, inserts } = createFakeDbCapturingInsertChains();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-chain",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const sessionInsert = findInsertWithExternalId(inserts);
    expect(sessionInsert).toBeDefined();
    const conflictTarget = onConflictTargetSchema.safeParse(sessionInsert?.onConflictArg);
    expect(conflictTarget.success).toBe(true);
    if (conflictTarget.success) {
      expect(conflictTarget.data.target.length).toBe(3);
    }
  });

  it("passes a returning projection containing `id` for sleep session insert", async () => {
    const { db, inserts } = createFakeDbCapturingInsertChains();
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-ret",
            startedAt: "2026-06-26T22:00:00Z",
            endedAt: "2026-06-27T06:00:00Z",
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const sessionInsert = findInsertWithExternalId(inserts);
    expect(sessionInsert).toBeDefined();
    expect(returningWithIdSchema.safeParse(sessionInsert?.returningArg).success).toBe(true);
  });

  it("passes the full sleep stage values object including session id from the upsert", async () => {
    // SELECT returns an existing sleep session row that the route uses as sessionId
    // for the stage insert when the upsert conflicts.
    const { db, inserts } = createFakeDbCapturingInsertChains({
      executeReturnByCall: [[], [{ id: "session-from-select" }]],
    });
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-with-stages-existing",
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

    // The session insert goes through returning() and our helper returns
    // [{ id: "inserted-session" }] — that id takes precedence over the SELECT row
    // when available. The stage insert should receive a non-empty values object
    // containing sessionId + stage + sourceName.
    const stageInsert = findInsertWithSessionId(inserts);
    expect(stageInsert).toBeDefined();
    const values = stageValuesSchema.parse(stageInsert?.valuesArg);
    expect(values.sessionId).toBeTruthy();
    expect(values.stage).toBe("deep");
    expect(values.sourceName).toBe("zepp-companion");
  });

  // ── Mutation-killing: existingSessionRows narrowing checks ──

  it("uses the SELECT row id when insert returned no row and SELECT id is a string", async () => {
    // Mimic a conflict: insert returns no row, SELECT returns the existing id.
    // The route narrows with typeof checks; mutating any narrowing predicate to
    // `true` should change which id is selected.
    const { db, inserts } = createFakeDbCapturingInsertChains({
      executeReturnByCall: [[], [{ id: "selected-existing-id" }]],
      sessionReturningRows: [],
    });
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-conflict-stages",
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

    const stageInsert = findInsertWithSessionId(inserts);
    expect(stageInsert).toBeDefined();
    const values = sessionIdValuesSchema.parse(stageInsert?.valuesArg);
    expect(values.sessionId).toBe("selected-existing-id");
  });

  it("does not insert sleep stage when SELECT returns a row whose id is not a string", async () => {
    // id is a number ⇒ `typeof === "string"` narrowing fails ⇒ existingId undefined
    // ⇒ no stage insert. Mutating the typeof check to `true` would let the numeric id
    // through and cause a stage insert with a numeric sessionId.
    const { db, inserts } = createFakeDbCapturingInsertChains({
      executeReturnByCall: [[], [{ id: 123 }]],
      sessionReturningRows: [],
    });
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-nonstring-id",
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

    expect(findInsertWithSessionId(inserts)).toBeUndefined();
  });

  it("does not insert sleep stage when SELECT returns no rows", async () => {
    // No existing session ⇒ existingId undefined ⇒ no stage insert.
    const { db, inserts } = createFakeDbCapturingInsertChains({
      executeReturnByCall: [[], []],
      sessionReturningRows: [],
    });
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-no-existing",
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

    expect(findInsertWithSessionId(inserts)).toBeUndefined();
  });

  it("kills the OptionalChaining mutant by returning undefined from the SELECT execute call", async () => {
    // When `db.execute` returns undefined for the SELECT, `existingSessionRows?.[0]`
    // short-circuits to undefined. Removing the optional chaining (`existingSessionRows[0]`)
    // would throw TypeError inside the inner try block.
    const { db, inserts } = createFakeDbCapturingInsertChains({
      undefinedSecondExecute: true,
      sessionReturningRows: [],
    });
    const { app } = createTestApp(db);
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        sleepSessions: [
          {
            externalId: "sleep-undefined-select",
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

    // No stage insert was possible because existingSessionRows is undefined.
    expect(findInsertWithSessionId(inserts)).toBeUndefined();
  });
});
