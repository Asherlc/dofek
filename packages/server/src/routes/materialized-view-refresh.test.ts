import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));
vi.mock("dofek/db/sync-views", () => ({
  syncMaterializedViews: vi.fn(),
}));
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";
import { syncMaterializedViews } from "dofek/db/sync-views";
import express from "express";
import { createMaterializedViewRefreshRouter } from "./materialized-view-refresh.ts";

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, {
        method: "POST",
        headers,
      })
        .then(async (response) => {
          resolve({ status: response.status, body: await response.text() });
          server.close();
        })
        .catch((error: unknown) => {
          Sentry.captureException(error);
          resolve({ status: 500, body: "fetch error" });
          server.close();
        });
    });
  });
}

function createTestApp(): express.Express {
  const app = express();
  app.use("/api/internal", createMaterializedViewRefreshRouter());
  return app;
}

describe("createMaterializedViewRefreshRouter", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRefreshToken = process.env.MATERIALIZED_VIEW_REFRESH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    process.env.MATERIALIZED_VIEW_REFRESH_TOKEN = "refresh-secret";
    vi.mocked(syncMaterializedViews).mockResolvedValue({ synced: 0, skipped: 7, refreshed: 0 });
  });

  afterEach(() => {
    if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    if (originalRefreshToken) {
      process.env.MATERIALIZED_VIEW_REFRESH_TOKEN = originalRefreshToken;
    } else {
      delete process.env.MATERIALIZED_VIEW_REFRESH_TOKEN;
    }
  });

  it("returns 401 when no bearer token is provided", async () => {
    const app = createTestApp();
    const response = await request(app, "/api/internal/materialized-views/refresh");
    expect(response.status).toBe(401);
  });

  it("returns 401 when bearer token is invalid", async () => {
    const app = createTestApp();
    const response = await request(app, "/api/internal/materialized-views/refresh", {
      authorization: "Bearer wrong-token",
    });
    expect(response.status).toBe(401);
  });

  it("returns 500 when MATERIALIZED_VIEW_REFRESH_TOKEN is missing", async () => {
    delete process.env.MATERIALIZED_VIEW_REFRESH_TOKEN;
    const app = createTestApp();
    const response = await request(app, "/api/internal/materialized-views/refresh", {
      authorization: "Bearer refresh-secret",
    });
    expect(response.status).toBe(500);
    expect(response.body).toContain("MATERIALIZED_VIEW_REFRESH_TOKEN");
  });

  it("returns 500 when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    const app = createTestApp();
    const response = await request(app, "/api/internal/materialized-views/refresh", {
      authorization: "Bearer refresh-secret",
    });
    expect(response.status).toBe(500);
    expect(response.body).toContain("DATABASE_URL");
  });

  it("starts refresh asynchronously and returns 202", async () => {
    const app = createTestApp();
    const response = await request(app, "/api/internal/materialized-views/refresh", {
      authorization: "Bearer refresh-secret",
    });

    expect(response.status).toBe(202);
    expect(response.body).toContain("started");
    expect(syncMaterializedViews).toHaveBeenCalledWith("postgres://test:test@localhost:5432/test");
  });

  it("returns already_running when a refresh is in progress", async () => {
    let resolveRefresh: (() => void) | undefined;
    vi.mocked(syncMaterializedViews).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => resolve({ synced: 0, skipped: 7, refreshed: 0 });
        }),
    );

    const app = createTestApp();
    const firstResponsePromise = request(app, "/api/internal/materialized-views/refresh", {
      authorization: "Bearer refresh-secret",
    });

    await vi.waitFor(() => {
      expect(resolveRefresh).toBeDefined();
    });

    const secondResponse = await request(app, "/api/internal/materialized-views/refresh", {
      authorization: "Bearer refresh-secret",
    });
    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body).toContain("already_running");

    resolveRefresh?.();
    await firstResponsePromise;
    expect(syncMaterializedViews).toHaveBeenCalledTimes(1);
  });
});
