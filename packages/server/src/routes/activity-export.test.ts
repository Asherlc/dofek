import type { AddressInfo } from "node:net";
import { TRPCError } from "@trpc/server";
import cookieParser from "cookie-parser";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
}));

vi.mock("../auth/session.ts", () => ({
  validateSession: vi.fn(),
}));

vi.mock("../billing/access-window-repository.ts", () => ({
  getAccessWindowForUser: vi.fn(async () => ({
    kind: "full",
    paid: true,
    reason: "paid_grant",
  })),
}));

vi.mock("../lib/activity-export-service.ts", () => ({
  exportActivityFile: vi.fn(),
}));

import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { getAccessWindowForUser } from "../billing/access-window-repository.ts";
import { exportActivityFile } from "../lib/activity-export-service.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { createActivityExportRouter } from "./activity-export.ts";

const activityId = "11111111-1111-1111-1111-111111111111";
const userId = "33333333-3333-3333-3333-333333333333";

const mockSensorStore = {
  query: vi.fn(),
  getActivitySummaries: vi.fn(),
  getPowerCurveSamples: vi.fn(),
  getNormalizedPowerSamples: vi.fn(),
  getVo2MaxEstimates: vi.fn(),
  getHeartRateCurveRows: vi.fn(),
  getPaceCurveRows: vi.fn(),
  getStream: vi.fn(),
  getHeartRateZoneSeconds: vi.fn(),
  getPowerZoneSeconds: vi.fn(),
  refreshBodyMeasurements: vi.fn(),
} satisfies ActivitySensorStore;

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(
    "/api/activity",
    createActivityExportRouter({
      db: { execute: vi.fn() },
      sensorStore: mockSensorStore,
    }),
  );
  return app;
}

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  method: "get",
  path: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: unknown; headers: Headers }>((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: method.toUpperCase(),
        headers,
      })
        .then(async (response) => {
          const contentType = response.headers.get("content-type") ?? "";
          const body = contentType.includes("json") ? await response.json() : await response.text();
          resolve({ status: response.status, body, headers: response.headers });
        })
        .catch(reject)
        .finally(() => {
          server.close((error) => {
            if (error) reject(error);
          });
        });
    });
  });
}

function authenticate() {
  vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
  vi.mocked(validateSession).mockResolvedValue({
    sessionId: "session-id",
    userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
}

describe("createActivityExportRouter", () => {
  beforeEach(() => {
    vi.mocked(getSessionIdFromRequest).mockReset();
    vi.mocked(validateSession).mockReset();
    vi.mocked(getAccessWindowForUser).mockClear();
    vi.mocked(exportActivityFile).mockReset();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Not authenticated" });
  });

  it("returns 401 when the session is expired", async () => {
    vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
    vi.mocked(validateSession).mockResolvedValue(null);

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Session expired" });
    expect(exportActivityFile).not.toHaveBeenCalled();
  });

  it("returns 400 when the activity id is invalid", async () => {
    authenticate();

    const response = await request(
      createTestApp(),
      "get",
      "/api/activity/not-a-uuid/export?format=csv",
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid activity id" });
    expect(exportActivityFile).not.toHaveBeenCalled();
  });

  it("returns 400 when the export format is invalid", async () => {
    authenticate();

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=pdf`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid export format" });
    expect(exportActivityFile).not.toHaveBeenCalled();
  });

  it("returns exported file bytes for authenticated requests", async () => {
    authenticate();
    vi.mocked(exportActivityFile).mockResolvedValue({
      body: Buffer.from("a,b\n1,2"),
      contentType: "text/csv; charset=utf-8",
      filename: "morning-run-11111111.csv",
    });

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("a,b\n1,2");
    expect(response.headers.get("content-disposition")).toContain("morning-run-11111111.csv");
    expect(exportActivityFile).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      "UTC",
      expect.objectContaining({ kind: "full" }),
      mockSensorStore,
      activityId,
      "csv",
    );
  });

  it("passes the timezone header into the export service", async () => {
    authenticate();
    vi.mocked(exportActivityFile).mockResolvedValue({
      body: Buffer.from("a,b\n1,2"),
      contentType: "text/csv; charset=utf-8",
      filename: "morning-run-11111111.csv",
    });

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
      { "x-timezone": "America/Los_Angeles" },
    );

    expect(response.status).toBe(200);
    expect(getAccessWindowForUser).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      "America/Los_Angeles",
    );
    expect(exportActivityFile).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      "America/Los_Angeles",
      expect.objectContaining({ kind: "full" }),
      mockSensorStore,
      activityId,
      "csv",
    );
  });

  it("returns 400 for an invalid timezone before access-window resolution", async () => {
    authenticate();

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
      { "x-timezone": "Not/A_Timezone" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid x-timezone header" });
    expect(getAccessWindowForUser).not.toHaveBeenCalled();
    expect(exportActivityFile).not.toHaveBeenCalled();
  });

  it("returns 400 when export preconditions fail", async () => {
    authenticate();
    vi.mocked(exportActivityFile).mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "GPX export requires GPS track points" }),
    );

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=gpx`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "GPX export requires GPS track points" });
  });

  it("returns 404 when the activity export target is not found", async () => {
    authenticate();
    vi.mocked(exportActivityFile).mockRejectedValue(
      new TRPCError({ code: "NOT_FOUND", message: "Activity not found" }),
    );

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Activity not found" });
  });

  it("does not map unsupported TRPC errors to export precondition responses", async () => {
    authenticate();
    vi.mocked(exportActivityFile).mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "No access to activity" }),
    );

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
    );

    expect(response.status).toBe(500);
  });

  it("does not map non-TRPC errors to export precondition responses", async () => {
    authenticate();
    vi.mocked(exportActivityFile).mockRejectedValue({
      code: "BAD_REQUEST",
      message: "Plain object failure",
    });

    const response = await request(
      createTestApp(),
      "get",
      `/api/activity/${activityId}/export?format=csv`,
    );

    expect(response.status).toBe(500);
  });
});
