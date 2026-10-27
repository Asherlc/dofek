import { once } from "node:events";
import { gzipSync } from "node:zlib";
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
  bodyFault: vi.fn(),
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
vi.mock("dofek/providers/garmin/payloads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dofek/providers/garmin/payloads")>();
  return { ...actual, parseGarminWebhookPayload: vi.fn(actual.parseGarminWebhookPayload) };
});
vi.mock("express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("express")>();
  return {
    ...actual,
    raw: (options: Parameters<typeof actual.raw>[0]) => {
      const parse = actual.raw(options);
      return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const failure = mocks.bodyFault();
        if (failure !== undefined) next(failure);
        else parse(req, res, next);
      };
    },
  };
});

import { parseGarminWebhookPayload } from "dofek/providers/garmin/payloads";
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

function setup(
  { sharedSecret }: { sharedSecret: string | undefined } = { sharedSecret: SECRET },
  beforeRouter?: express.RequestHandler,
) {
  const { db } = createMockDatabase();
  const enqueueEvent = vi.fn<(userId: string, event: WebhookEvent) => Promise<void>>(
    async () => {},
  );
  const app = express();
  if (beforeRouter) app.use(beforeRouter);
  app.use("/api/webhooks/garmin", createGarminWebhookRouter({ db, sharedSecret, enqueueEvent }));
  return { app, db, enqueueEvent };
}

async function post(
  app: express.Express,
  path: string,
  body: unknown = payload,
  raw = false,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw
        ? body instanceof Uint8Array
          ? new Uint8Array(body)
          : String(body)
        : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Garmin portal webhook receiver", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const actual = await vi.importActual<typeof import("dofek/providers/garmin/payloads")>(
      "dofek/providers/garmin/payloads",
    );
    vi.mocked(parseGarminWebhookPayload).mockImplementation(actual.parseGarminWebhookPayload);
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

  it.each([undefined, "", "x".repeat(31)])(
    "fails closed for an invalid receiver secret %s",
    async (sharedSecret) => {
      const { app, enqueueEvent } = setup({ sharedSecret });
      const response = await post(app, "/api/webhooks/garmin", "malformed-json", true);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: "GARMIN_WEBHOOK_SECRET must contain at least 32 characters",
      });
      expect(mocks.findOwners).not.toHaveBeenCalled();
      expect(enqueueEvent).not.toHaveBeenCalled();
    },
  );

  it("accepts the minimum 32-byte secret", async () => {
    const sharedSecret = "x".repeat(32);
    const { app } = setup({ sharedSecret });
    expect(await post(app, `/api/webhooks/garmin?token=${sharedSecret}`)).toEqual({
      status: 200,
      body: { status: "accepted" },
    });
  });

  it.each([
    "",
    "?token=wrong",
    `?token=${"x".repeat(SECRET.length)}`,
    "?client_id=public-client-id",
    `?token=${SECRET}&token=${SECRET}`,
  ])("rejects unauthenticated delivery before parsing %s", async (query) => {
    const { app, enqueueEvent } = setup();
    const response = await post(app, `/api/webhooks/garmin${query}`, "malformed-json", true);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid Garmin receiver token" });
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("queues the validated original event and grant/deletion generations before acknowledging", async () => {
    const { app, db, enqueueEvent } = setup();
    const response = await post(app, `/api/webhooks/garmin?token=${SECRET}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "accepted" });
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
      { tags: { provider: "garmin", operation: "webhook-owner-lookup" } },
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
      expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`)).toEqual({
        status: 503,
        body: { error: "Garmin notification could not be queued; retry delivery" },
      });
      expect(mocks.capture).toHaveBeenCalledWith(error, {
        tags: {
          provider: "garmin",
          operation: phase === "lookup" ? "webhook-owner-lookup" : "webhook-enqueue",
        },
      });
    },
  );

  it("fails loudly when a current official authorization lacks its grant identifier", async () => {
    mocks.loadTokens.mockResolvedValue({ providerAccountId: "garmin-owner" });
    const { app } = setup();
    expect((await post(app, `/api/webhooks/garmin?token=${SECRET}`)).status).toBe(503);
    expect(mocks.capture).toHaveBeenCalled();
  });

  it.each([
    "",
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ nutrition: [] }),
    JSON.stringify({ email: "user@example.com", password: "credentials" }),
  ])("rejects malformed or unsupported JSON before owner lookup %s", async (body) => {
    const { app, enqueueEvent } = setup();
    expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`, body, true)).toEqual({
      status: 400,
      body: { error: "Invalid Garmin notification payload" },
    });
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("rejects requests whose raw body was consumed by earlier middleware", async () => {
    const { app, enqueueEvent } = setup({ sharedSecret: SECRET }, express.json());
    expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`)).toEqual({
      status: 400,
      body: { error: "Garmin notification must contain a JSON body" },
    });
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("reports unexpected parser failures as retryable delivery errors", async () => {
    const failure = new Error("parser unavailable");
    vi.mocked(parseGarminWebhookPayload).mockImplementationOnce(() => {
      throw failure;
    });
    const { app, enqueueEvent } = setup();
    expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`)).toEqual({
      status: 503,
      body: { error: "Garmin notification parsing failed; retry delivery" },
    });
    expect(mocks.capture).toHaveBeenCalledWith(failure, {
      tags: { provider: "garmin", operation: "webhook-parse" },
    });
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("rejects a valid compressed body rather than inflating authenticated input", async () => {
    const { app, enqueueEvent } = setup();
    expect(
      await post(
        app,
        `/api/webhooks/garmin?token=${SECRET}`,
        gzipSync(JSON.stringify(payload)),
        true,
        { "content-encoding": "gzip" },
      ),
    ).toEqual({
      status: 400,
      body: { error: "Invalid Garmin notification body" },
    });
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each(["encoding.unsupported", "request.aborted", "request.size.invalid"])(
    "rejects malformed request bodies reported by the parser as %s",
    async (type) => {
      mocks.bodyFault.mockReturnValueOnce(Object.assign(new Error(type), { type }));
      const { app, enqueueEvent } = setup();
      expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`)).toEqual({
        status: 400,
        body: { error: "Invalid Garmin notification body" },
      });
      expect(mocks.findOwners).not.toHaveBeenCalled();
      expect(enqueueEvent).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error("request stream unavailable"),
    "unexpected request parser failure",
    { type: "unknown.body.failure" },
  ])(
    "reports unexpected body parser failures without acknowledging delivery %j",
    async (failure) => {
      mocks.bodyFault.mockReturnValueOnce(failure);
      const { app, enqueueEvent } = setup();
      expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`)).toEqual({
        status: 503,
        body: { error: "Garmin notification could not be received; retry delivery" },
      });
      expect(mocks.capture).toHaveBeenCalledWith(failure, {
        tags: { provider: "garmin", operation: "webhook-body" },
      });
      expect(mocks.findOwners).not.toHaveBeenCalled();
      expect(enqueueEvent).not.toHaveBeenCalled();
    },
  );

  it("bounds the authenticated raw request body", async () => {
    const { app, enqueueEvent } = setup();
    const body = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
    expect(await post(app, `/api/webhooks/garmin?token=${SECRET}`, body, true)).toEqual({
      status: 413,
      body: { error: "Garmin notification body exceeds 1 MiB" },
    });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
