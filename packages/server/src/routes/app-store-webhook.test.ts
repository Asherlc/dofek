import { TRPCError } from "@trpc/server";
import type { AppStoreNotificationUpdate } from "dofek/billing/app-store-verifier";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationUuid = "20000000-0000-4000-8000-000000000001";
const accountToken = "a0000000-0000-4000-8000-000000000001";

const appStoreMocks = vi.hoisted(() => ({
  invalidateAllUserQueries: vi.fn<(userId: string) => Promise<void>>(async () => undefined),
  verifyAppStoreNotification: vi.fn(),
  captureException: vi.fn<(error: unknown) => void>(),
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: appStoreMocks.invalidateAllUserQueries,
}));

vi.mock("../billing/app-store-verifier.ts", () => ({
  verifyAppStoreNotification: appStoreMocks.verifyAppStoreNotification,
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: appStoreMocks.captureException,
}));

import { createAppStoreWebhookRouter } from "./app-store-webhook.ts";

const verifiedNotification = {
  notificationUuid,
  signedDate: 1_788_275_200_000,
  subscription: {
    accountToken,
    originalTransactionId: "100000000000001",
    transactionId: "100000000000002",
    productId: "com.dofek.premium.monthly" as const,
    status: "active" as const,
    expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    revokedAt: null,
    environment: "Sandbox" as const,
  },
} satisfies AppStoreNotificationUpdate;

function createTestApp(execute: ReturnType<typeof vi.fn>) {
  const db = {
    execute,
    transaction: vi.fn(async (operation: (transaction: { execute: typeof execute }) => unknown) =>
      operation({ execute }),
    ),
  };
  const unexpectedErrors: unknown[] = [];
  const app = express();
  app.use("/api/webhooks/app-store", createAppStoreWebhookRouter({ db }));
  app.use(express.json());
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      unexpectedErrors.push(error);
      response.status(500).json({ error: "Internal server error" });
    },
  );
  return { app, db, unexpectedErrors };
}

async function postJson(app: express.Express, body: string): Promise<Response> {
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a port");
    }
    return await fetch(`http://127.0.0.1:${address.port}/api/webhooks/app-store`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } finally {
    server.close();
  }
}

describe("App Store webhook route", () => {
  beforeEach(() => {
    appStoreMocks.invalidateAllUserQueries.mockReset();
    appStoreMocks.invalidateAllUserQueries.mockResolvedValue(undefined);
    appStoreMocks.verifyAppStoreNotification.mockReset();
    appStoreMocks.verifyAppStoreNotification.mockResolvedValue(verifiedNotification);
    appStoreMocks.captureException.mockReset();
  });

  it("records and applies a verified subscription notification atomically", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ user_id: "user-1" }])
      .mockResolvedValueOnce([{ notification_uuid: notificationUuid }]);
    const { app, db } = createTestApp(execute);

    const response = await postJson(
      app,
      JSON.stringify({ signedPayload: "verified-notification-jws" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(appStoreMocks.verifyAppStoreNotification).toHaveBeenCalledWith(
      "verified-notification-jws",
    );
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("user_billing");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(accountToken);
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("app_store_notification");
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain(notificationUuid);
    expect(appStoreMocks.invalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("acknowledges a duplicate verified notification without applying it again", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ user_id: "user-1" }]);
    const { app, db } = createTestApp(execute);

    const response = await postJson(
      app,
      JSON.stringify({ signedPayload: "verified-notification-jws" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(appStoreMocks.invalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("acknowledges and records a verified Apple test notification without a billing update", async () => {
    appStoreMocks.verifyAppStoreNotification.mockResolvedValueOnce({
      notificationUuid,
      signedDate: 1_788_275_200_000,
      subscription: null,
    });
    const execute = vi.fn().mockResolvedValueOnce([{ notification_uuid: notificationUuid }]);
    const { app, db } = createTestApp(execute);

    const response = await postJson(
      app,
      JSON.stringify({ signedPayload: "verified-test-notification-jws" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(appStoreMocks.invalidateAllUserQueries).not.toHaveBeenCalled();
  });

  it("returns 400 without a write when notification verification fails", async () => {
    appStoreMocks.verifyAppStoreNotification.mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "App Store notification could not be verified",
      }),
    );
    const execute = vi.fn();
    const { app, db, unexpectedErrors } = createTestApp(execute);

    const response = await postJson(app, JSON.stringify({ signedPayload: "invalid-jws" }));

    expect(response.status).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(unexpectedErrors).toEqual([]);
  });

  it("returns 400 without verification or writes for a malformed request body", async () => {
    const execute = vi.fn();
    const { app, db, unexpectedErrors } = createTestApp(execute);

    const responses = await Promise.all([
      postJson(app, "not-json"),
      postJson(app, JSON.stringify({ signedPayload: "jws", unexpected: true })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400]);
    expect(appStoreMocks.verifyAppStoreNotification).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(unexpectedErrors).toEqual([]);
  });

  it("forwards unexpected persistence errors to the shared Express error handler", async () => {
    const databaseError = new Error("database unavailable");
    const execute = vi.fn().mockRejectedValueOnce(databaseError);
    const { app, unexpectedErrors } = createTestApp(execute);

    const response = await postJson(
      app,
      JSON.stringify({ signedPayload: "verified-notification-jws" }),
    );

    expect(response.status).toBe(500);
    expect(unexpectedErrors).toEqual([databaseError]);
    expect(appStoreMocks.captureException).toHaveBeenCalledWith(databaseError, {
      tags: { source: "app-store-webhook" },
    });
  });
});
