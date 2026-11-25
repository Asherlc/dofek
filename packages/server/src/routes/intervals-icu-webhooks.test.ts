import type { AddressInfo } from "node:net";
import type { SyncDatabase } from "dofek/db";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOwners: vi.fn(),
  loadTokens: vi.fn(),
  fence: vi.fn(),
  enqueueSyncJob: vi.fn(async () => ({ id: "job-1" })),
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
vi.mock("dofek/jobs/enqueue-sync-job", () => ({
  enqueueSyncJob: (...args: unknown[]) => mocks.enqueueSyncJob(...args),
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: mocks.capture }));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => [],
}));
vi.mock("../routers/sync-helpers.ts", () => ({
  ensureProvidersRegistered: vi.fn(async () => {}),
}));
vi.mock("../logger.ts", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({
    execute: vi.fn(async () => []),
    select: vi.fn(),
  })),
}));

import { createDatabaseFromEnv } from "dofek/db";
import { createWebhookRouter } from "./webhooks.ts";

const SECRET = "intervals-icu-webhook-test-secret";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const ATHLETE_A = "i2049151";
const ATHLETE_B = "i9990001";

function delivery(
  events: unknown[],
  secret: string = SECRET,
): { secret: string; events: unknown[] } {
  return { secret, events };
}

function event(
  type: string,
  athleteId: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
) {
  return { type, athlete_id: athleteId, timestamp, ...extra };
}

const mockQueue = { add: vi.fn(async () => {}) };

function setup(options: { webhookSecret?: string | undefined } = { webhookSecret: SECRET }) {
  const db = createDatabaseFromEnv();
  const app = express();
  app.use(
    "/api/webhooks",
    createWebhookRouter({
      db,
      syncQueue: mockQueue,
      intervalsIcuWebhookSecret: options.webhookSecret,
    }),
  );
  return { app, db };
}

async function post(
  app: express.Express,
  body?: unknown,
  options: { raw?: boolean; omitBody?: boolean } = {},
): Promise<{ status: number; body: string }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port");
  const { port } = address satisfies AddressInfo;
  try {
    const init: RequestInit = { method: "POST" };
    if (!options.omitBody) {
      init.headers = { "content-type": "application/json" };
      init.body = options.raw
        ? body instanceof Uint8Array
          ? new Uint8Array(body)
          : String(body)
        : JSON.stringify(body);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/intervals.icu`, init);
    return { status: response.status, body: await response.text() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Intervals.icu webhook receiver", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findOwners.mockResolvedValue([USER_A]);
    mocks.loadTokens.mockResolvedValue({
      accessToken: "icu-access",
      refreshToken: null,
      providerAccountId: ATHLETE_A,
      scopes: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    mocks.fence.mockImplementation(
      async (
        db: SyncDatabase,
        _userId: string,
        work: (transaction: SyncDatabase) => Promise<unknown>,
      ) => work(db),
    );
    mocks.enqueueSyncJob.mockResolvedValue({ id: "job-1" });
  });

  it.each([undefined, "", "   "] as const)(
    "returns 503 naming INTERVALS_ICU_WEBHOOK_SECRET when unset %j",
    async (webhookSecret) => {
      const { app } = setup({ webhookSecret });
      const response = await post(
        app,
        delivery([event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00")]),
      );
      expect(response.status).toBe(503);
      expect(response.body).toContain("INTERVALS_ICU_WEBHOOK_SECRET");
      expect(mocks.findOwners).not.toHaveBeenCalled();
      expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
    },
  );

  it("rejects a POST without a parsed body before ownership lookup", async () => {
    const { app } = setup();
    const response = await post(app, undefined, { omitBody: true });
    expect(response.status).toBe(400);
    expect(response.body).toBe("Expected a JSON request body");
    expect(mocks.findOwners).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before ownership lookup", async () => {
    const { app } = setup();
    const response = await post(app, "{not-json", { raw: true });
    expect(response.status).toBe(400);
    expect(response.body).toBe("Invalid JSON");
    expect(response.body).not.toMatch(/not-json|icu-access|SECRET|i2049151/i);
    expect(mocks.findOwners).not.toHaveBeenCalled();
  });

  it("rejects an invalid envelope before auth comparison", async () => {
    const { app } = setup();
    const response = await post(app, { events: [] });
    expect(response.status).toBe(400);
    expect(mocks.findOwners).not.toHaveBeenCalled();
  });

  it.each([
    ["equal length", "x".repeat(SECRET.length)],
    ["shorter", "short-secret"],
    ["longer", `${SECRET}-extra`],
  ] as const)(
    "rejects a wrong secret (%s) with 401 before ownership lookup",
    async (_label, wrongSecret) => {
      const { app } = setup();
      const response = await post(
        app,
        delivery(
          [event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00")],
          wrongSecret,
        ),
      );
      expect(response.status).toBe(401);
      expect(response.body).not.toContain(SECRET);
      expect(response.body).not.toContain(wrongSecret);
      expect(mocks.findOwners).not.toHaveBeenCalled();
      expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
    },
  );

  it("rejects actionable events that omit athlete_id or a valid offset timestamp", async () => {
    const { app } = setup();
    for (const bad of [
      { type: "ACTIVITY_UPLOADED", timestamp: "2024-12-06T06:40:47.011+00:00" },
      {
        type: "WELLNESS_UPDATED",
        athlete_id: ATHLETE_A,
        timestamp: "2024-12-06T06:40:47",
      },
      { type: "CALENDAR_UPDATED", athlete_id: "", timestamp: "2024-12-06T06:40:47.011+00:00" },
      { type: "ACTIVITY_DELETED", athlete_id: ATHLETE_A, timestamp: "not-a-timestamp" },
    ]) {
      const response = await post(app, delivery([bad]));
      expect(response.status).toBe(400);
      expect(mocks.findOwners).not.toHaveBeenCalled();
    }
  });

  it("acknowledges empty and unknown event deliveries without enqueue", async () => {
    const { app } = setup();
    expect((await post(app, delivery([]))).status).toBe(200);
    expect(
      (
        await post(
          app,
          delivery([
            {
              type: "SPORT_SETTINGS_UPDATED",
              athlete_id: ATHLETE_A,
              timestamp: "2024-12-06T06:40:47.011+00:00",
            },
            { type: "TEST", garbage: true },
          ]),
        )
      ).status,
    ).toBe(200);
    expect(mocks.findOwners).not.toHaveBeenCalled();
    expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
  });

  it.each([
    "ACTIVITY_UPLOADED",
    "ACTIVITY_ANALYZED",
    "ACTIVITY_DELETED",
    "CALENDAR_UPDATED",
    "WELLNESS_UPDATED",
  ] as const)("queues a one-day manual sync for %s", async (type) => {
    const { app, db } = setup();
    const timestamp = "2024-12-06T06:40:47.011+00:00";
    const response = await post(app, delivery([event(type, ATHLETE_A, timestamp)]));
    expect(response.status).toBe(200);
    expect(mocks.findOwners).toHaveBeenCalledWith(db, "intervals.icu", ATHLETE_A);
    expect(mocks.fence).toHaveBeenCalledWith(db, USER_A, expect.any(Function));
    expect(mocks.loadTokens).toHaveBeenCalledWith(db, "intervals.icu", USER_A);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledWith("intervals.icu", {
      providerId: "intervals.icu",
      userId: USER_A,
      sinceDays: 1,
      origin: "manual",
      requestedAtIso: new Date(timestamp).toISOString(),
    });
  });

  it("coalesces duplicate athlete events onto the latest vendor timestamp anchor", async () => {
    const { app } = setup();
    const response = await post(
      app,
      delivery([
        event("ACTIVITY_UPLOADED", ` ${ATHLETE_A} `, "2024-12-06T06:40:47.011+00:00"),
        event("ACTIVITY_ANALYZED", ATHLETE_A, "2024-12-06T06:41:10.500+00:00"),
        event("WELLNESS_UPDATED", ATHLETE_A, "2024-12-06T06:39:00.000+00:00"),
      ]),
    );
    expect(response.status).toBe(200);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledWith(
      "intervals.icu",
      expect.objectContaining({
        userId: USER_A,
        requestedAtIso: new Date("2024-12-06T06:41:10.500+00:00").toISOString(),
      }),
    );
  });

  it("queues independent athletes separately", async () => {
    mocks.findOwners.mockImplementation(async (_db, _provider, athleteId: string) => {
      if (athleteId === ATHLETE_A) return [USER_A];
      if (athleteId === ATHLETE_B) return [USER_B];
      return [];
    });
    mocks.loadTokens.mockImplementation(async (_db, _provider, userId: string) => ({
      accessToken: "icu-access",
      refreshToken: null,
      providerAccountId: userId === USER_A ? ATHLETE_A : ATHLETE_B,
      scopes: "ACTIVITY:READ",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    }));
    const { app } = setup();
    const response = await post(
      app,
      delivery([
        event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00"),
        event("CALENDAR_UPDATED", ATHLETE_B, "2024-12-06T07:00:00.000+00:00"),
      ]),
    );
    expect(response.status).toBe(200);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledWith(
      "intervals.icu",
      expect.objectContaining({ userId: USER_A }),
    );
    expect(mocks.enqueueSyncJob).toHaveBeenCalledWith(
      "intervals.icu",
      expect.objectContaining({
        userId: USER_B,
        requestedAtIso: new Date("2024-12-06T07:00:00.000+00:00").toISOString(),
      }),
    );
  });

  it("acknowledges unconnected athletes without enqueue", async () => {
    mocks.findOwners.mockResolvedValue([]);
    const { app } = setup();
    expect(
      (
        await post(
          app,
          delivery([event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00")]),
        )
      ).status,
    ).toBe(200);
    expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
  });

  it("skips when tokens disappear or the athlete binding changed under the fence", async () => {
    mocks.loadTokens.mockResolvedValueOnce(null).mockResolvedValueOnce({
      accessToken: "icu-access",
      refreshToken: null,
      providerAccountId: "i-other",
      scopes: null,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    const { app } = setup();
    for (const _ of [0, 1]) {
      expect(
        (
          await post(
            app,
            delivery([event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00")]),
          )
        ).status,
      ).toBe(200);
    }
    expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
  });

  it("skips an account being erased", async () => {
    mocks.fence.mockRejectedValue(new mocks.FencedError("erasing"));
    const { app } = setup();
    expect(
      (
        await post(
          app,
          delivery([event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00")]),
        )
      ).status,
    ).toBe(200);
    expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
  });

  it("returns 503 for an ambiguous owner so the vendor can retry", async () => {
    mocks.findOwners.mockResolvedValue([USER_A, USER_B]);
    const { app } = setup();
    const response = await post(
      app,
      delivery([event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00")]),
    );
    expect(response.status).toBe(503);
    expect(response.body).not.toContain(ATHLETE_A);
    expect(response.body).not.toContain(USER_A);
    expect(mocks.enqueueSyncJob).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalled();
  });

  it("continues other athletes when one queue fails, then returns 503", async () => {
    mocks.findOwners.mockImplementation(async (_db, _provider, athleteId: string) => {
      if (athleteId === ATHLETE_A) return [USER_A];
      if (athleteId === ATHLETE_B) return [USER_B];
      return [];
    });
    mocks.loadTokens.mockImplementation(async (_db, _provider, userId: string) => ({
      accessToken: "icu-access",
      refreshToken: null,
      providerAccountId: userId === USER_A ? ATHLETE_A : ATHLETE_B,
      scopes: "ACTIVITY:READ",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    }));
    mocks.enqueueSyncJob.mockImplementation(async (_provider, job: { userId: string }) => {
      if (job.userId === USER_A) throw new Error("queue unavailable");
      return { id: "job-b" };
    });
    const { app } = setup();
    const response = await post(
      app,
      delivery([
        event("ACTIVITY_UPLOADED", ATHLETE_A, "2024-12-06T06:40:47.011+00:00"),
        event("WELLNESS_UPDATED", ATHLETE_B, "2024-12-06T07:00:00.000+00:00"),
      ]),
    );
    expect(response.status).toBe(503);
    expect(mocks.enqueueSyncJob).toHaveBeenCalledWith(
      "intervals.icu",
      expect.objectContaining({ userId: USER_B }),
    );
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          provider: "intervals.icu",
          operation: "webhook-dispatch",
        }),
      }),
    );
    const capturePayload = JSON.stringify(mocks.capture.mock.calls);
    expect(capturePayload).not.toContain(SECRET);
    expect(capturePayload).not.toContain("icu-access");
    expect(capturePayload).not.toContain(ATHLETE_A);
  });
});
