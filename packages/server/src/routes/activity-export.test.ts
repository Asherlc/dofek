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

import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express from "express";
import { TRPCError } from "@trpc/server";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { exportActivityFile } from "../lib/activity-export-service.ts";
import { createActivityExportRouter } from "./activity-export.ts";

const activityId = "11111111-1111-1111-1111-111111111111";
const userId = "33333333-3333-3333-3333-333333333333";

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(
    "/api/activity",
    createActivityExportRouter({
      db: { execute: vi.fn() },
      sensorStore: {} as never,
    }),
  );
  return app;
}

async function request(
  app: express.Express,
  method: "get",
  path: string,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: method.toUpperCase(),
      headers,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    return { status: response.status, body, headers: response.headers };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("createActivityExportRouter", () => {
  beforeEach(() => {
    vi.mocked(getSessionIdFromRequest).mockReset();
    vi.mocked(validateSession).mockReset();
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

  it("returns exported file bytes for authenticated requests", async () => {
    vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
    vi.mocked(validateSession).mockResolvedValue({
      sessionId: "session-id",
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
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
      expect.anything(),
      activityId,
      "csv",
    );
  });

  it("returns 400 when export preconditions fail", async () => {
    vi.mocked(getSessionIdFromRequest).mockReturnValue("session-id");
    vi.mocked(validateSession).mockResolvedValue({
      sessionId: "session-id",
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
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
});
