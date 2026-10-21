import { once } from "node:events";
import type { SyncDatabase } from "dofek/db";
import type { WebhookEvent } from "dofek/providers/types";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDatabase } from "../../../../src/providers/test-helpers.ts";

const mocks = vi.hoisted(() => ({
  findOwners: vi.fn(),
  loadTokens: vi.fn(),
  readState: vi.fn(),
  fence: vi.fn(),
  capture: vi.fn(),
  FencedError: class FencedError extends Error {},
}));

vi.mock("dofek/db/tokens", () => ({
  findTokenUsersByProviderAccountId: mocks.findOwners,
  loadTokens: mocks.loadTokens,
}));
vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: mocks.fence,
  AccountErasureUserFencedError: mocks.FencedError,
}));
vi.mock("dofek/providers/garmin/authorization", () => ({
  readGarminDeliveryState: mocks.readState,
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: mocks.capture }));

import { createGarminWebhookRouter } from "./garmin-webhooks.ts";

const SECRET = "garmin-receiver-secret-with-at-least-32-characters";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const GRANT_ID = "64000000-0000-4000-8000-000000000001";
const payload = {
  dailies: [
    {
      userId: "garmin-owner",
      summaryId: "daily-summary",
      calendarDate: "2026-10-20",
      startTimeInSeconds: 1792454400,
      durationInSeconds: 86400,
      steps: 4000,
    },
  ],
};

function setup(sharedSecret: string | undefined = SECRET) {
  const { db } = createMockDatabase();
  const enqueueEvent = vi.fn<(userId: string, event: WebhookEvent) => Promise<void>>(
    async () => {},
  );
  const app = express();
  app.use("/api/webhooks/garmin", createGarminWebhookRouter({ db, sharedSecret, enqueueEvent }));
  return { app, db, enqueueEvent };
}

async function post(app: express.Express, path: string, body: unknown = payload, raw = false) {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? String(body) : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Garmin portal webhook receiver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOwners.mockResolvedValue([USER_ID]);
    mocks.loadTokens.mockResolvedValue({
      accessToken: "official-token",
      refreshToken: "refresh-token",
      providerAccountId: "garmin-owner",
      authorizationId: GRANT_ID,
      scopes: "HEALTH_EXPORT ACTIVITY_EXPORT",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    mocks.readState.mockResolvedValue({ generation: 3, pendingDeletion: false });
    mocks.fence.mockImplementation(
      async (
        db: SyncDatabase,
        _userId: string,
        work: (transaction: SyncDatabase) => Promise<unknown>,
      ) => work(db),
    );
  });

  it("fails closed when the configured receiving secret is missing", async () => {
    const { app, enqueueEvent } = setup("");
    const response = await post(app, "/api/webhooks/garmin", "malformed-json", true);
    expect(response.status).toBe(503);
    expect(response.body).toHaveProperty("error", expect.stringContaining("GARMIN_WEBHOOK_SECRET"));
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it.each(["", "?token=wrong", "?client_id=public-client-id", `?token=${SECRET}&token=${SECRET}`])(
    "rejects unauthenticated delivery before parsing %s",
    async (query) => {
      const { app, enqueueEvent } = setup();
      const response = await post(app, `/api/webhooks/garmin${query}`, "malformed-json", true);
      expect(response.status).toBe(401);
      expect(mocks.findOwners).not.toHaveBeenCalled();
      expect(enqueueEvent).not.toHaveBeenCalled();
    },
  );

  it("queues the validated original event and grant/deletion generations before acknowledging", async () => {
    const { app, db, enqueueEvent } = setup();
    const response = await post(app, `/api/webhooks/garmin?token=${SECRET}`);
    expect(response.status).toBe(200);
    expect(mocks.findOwners).toHaveBeenCalledWith(db, "garmin", "garmin-owner");
    expect(mocks.fence).toHaveBeenCalledWith(db, USER_ID, expect.any(Function));
    expect(mocks.loadTokens).toHaveBeenCalledWith(db, "garmin", USER_ID);
    expect(mocks.readState).toHaveBeenCalledWith(db, USER_ID);
    expect(enqueueEvent).toHaveBeenCalledWith(USER_ID, {
      ownerExternalId: "garmin-owner",
      eventType: "update",
      objectType: "dailies",
      objectId: "daily-summary",
      metadata: {
        payload: payload.dailies[0],
        authorizationId: GRANT_ID,
        providerDataGeneration: 3,
      },
    });
  });

  it("does not acknowledge while durable enqueue is pending", async () => {
    const { app, enqueueEvent } = setup();
    let release: () => void = () => {
      throw new Error("Queue barrier is uninitialized");
    };
    let reportAdmission: () => void = () => {
      throw new Error("Admission barrier is uninitialized");
    };
    const admitted = new Promise<void>((resolve) => {
      reportAdmission = resolve;
    });
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    enqueueEvent.mockImplementation(async () => {
      reportAdmission();
      await queued;
    });
    let acknowledged = false;
    const delivery = post(app, `/api/webhooks/garmin?token=${SECRET}`).then((response) => {
      acknowledged = true;
      return response;
    });
    const first = await Promise.race([
      admitted.then(() => "admitted"),
      delivery.then(() => "acknowledged"),
    ]);
    release();
    expect(first).toBe("admitted");
    expect(acknowledged).toBe(false);
    expect((await delivery).status).toBe(200);
  });

  it("fails closed if one Garmin account unexpectedly resolves to multiple Dofek owners", async () => {
    mocks.findOwners.mockResolvedValue([USER_ID, "other-owner"]);
    const { app, enqueueEvent } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(503);
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("multiple Dofek owners") }),
      expect.any(Object),
    );
  });

  it.each([
    null,
    { providerAccountId: "different-owner" },
    { accessToken: "legacy-private-credentials" },
  ])("ignores disconnected, replaced or legacy authorizations %j", async (tokens) => {
    mocks.loadTokens.mockResolvedValue(tokens);
    const { app, enqueueEvent } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(200);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("acknowledges an unknown external owner without queuing unrelated work", async () => {
    mocks.findOwners.mockResolvedValue([]);
    const { app, enqueueEvent } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(200);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("ignores an owner currently being erased", async () => {
    mocks.fence.mockRejectedValue(new mocks.FencedError());
    const { app, enqueueEvent } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(200);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("retains the current data generation when cleanup is pending", async () => {
    mocks.readState.mockResolvedValue({ generation: 4, pendingDeletion: true });
    const { app, enqueueEvent } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(200);
    expect(enqueueEvent).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        metadata: expect.objectContaining({ providerDataGeneration: 4 }),
      }),
    );
  });

  it.each(["lookup", "tokens", "state", "queue"])(
    "returns retryable failure when %s fails",
    async (phase) => {
      const { app, enqueueEvent } = setup();
      const error = new Error(`${phase} unavailable`);
      if (phase === "lookup") mocks.findOwners.mockRejectedValue(error);
      if (phase === "tokens") mocks.loadTokens.mockRejectedValue(error);
      if (phase === "state") mocks.readState.mockRejectedValue(error);
      if (phase === "queue") enqueueEvent.mockRejectedValue(error);
      expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(503);
      expect(mocks.capture).toHaveBeenCalledWith(error, expect.any(Object));
    },
  );

  it("fails loudly when a current official authorization lacks its grant identifier", async () => {
    mocks.loadTokens.mockResolvedValue({ providerAccountId: "garmin-owner" });
    const { app } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(503);
    expect(mocks.capture).toHaveBeenCalled();
  });

  it.each([
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ nutrition: [] }),
    JSON.stringify({ email: "user@example.com", password: "credentials" }),
  ])("rejects malformed or unsupported JSON before owner lookup %s", async (body) => {
    const { app, enqueueEvent } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`, body, true)).status).toBe(400);
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("bounds the authenticated raw request body", async () => {
    const { app, enqueueEvent } = setup();
    const body = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`, body, true)).status).toBe(413);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
