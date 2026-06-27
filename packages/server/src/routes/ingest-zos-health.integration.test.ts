import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";

const { createIngestZosHealthRouter } = await import("./ingest-zos-health.ts");

function createFakeDb(): import("dofek/db").Database {
  return {
    execute: vi.fn(async () => []),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 1 }]),
        })),
      })),
    })),
  } satisfies import("dofek/db").Database;
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

  it("returns 401 when companion token is invalid", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer invalid-token" },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid or revoked companion token." });
  });

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

  it("returns 200 and processes dailyMetrics", async () => {
    const { app } = createTestApp();
    const res = await post(app, "/api/ingest/zos-health", {
      headers: { Authorization: "Bearer valid-token" },
      body: {
        dailyMetrics: {
          "2026-06-26": { steps: 10000, calories: 500 },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns 200 and processes sleepSessions", async () => {
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
});
