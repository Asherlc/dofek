import type { AddressInfo } from "node:net";
import type { WebhookEvent, WebhookProvider } from "dofek/providers/types";
import { encryptCredentialValue } from "dofek/security/credential-encryption";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const {
  MockAccountErasureUserFencedError,
  mockEnqueueSyncJob,
  mockLogger,
  mockWithUserWriteFence,
} = vi.hoisted(() => ({
  MockAccountErasureUserFencedError: class MockAccountErasureUserFencedError extends Error {},
  mockEnqueueSyncJob: vi.fn(async () => ({ id: "job-1" })),
  mockLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  mockWithUserWriteFence: vi.fn(),
}));
const mockFenceTransaction = { execute: vi.fn(async () => []) };

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("dofek/jobs/enqueue-sync-job", () => ({
  enqueueSyncJob: (...args: unknown[]) => mockEnqueueSyncJob(...args),
}));

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureUserFencedError: MockAccountErasureUserFencedError,
  withAccountErasureUserWriteFence: mockWithUserWriteFence,
}));

const mockGetAllProviders = vi.fn<() => Array<Record<string, unknown>>>(() => []);

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => mockGetAllProviders(),
}));

vi.mock("dofek/providers/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dofek/providers/types")>();
  return { ...actual };
});

vi.mock("../routers/sync-helpers.ts", () => ({
  ensureProvidersRegistered: vi.fn(async () => {}),
}));

const mockExecuteWithSchema = vi.fn(async () => []);
vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: (...args: unknown[]) => mockExecuteWithSchema(...args),
}));

vi.mock("../logger.ts", () => ({ logger: mockLogger }));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({
    execute: vi.fn(async () => [{ id: "pending-1" }]),
  })),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { createDatabaseFromEnv } from "dofek/db";
import express from "express";
import { createWebhookRouter, registerWebhookForProvider } from "./webhooks.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockWebhookProvider(overrides: Partial<WebhookProvider> = {}): WebhookProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    validate: () => null,
    sync: vi.fn(async () => ({
      provider: "test-provider",
      recordsSynced: 0,
      errors: [],
      duration: 0,
    })),
    webhookScope: "app",
    registerWebhook: vi.fn(async () => ({ subscriptionId: "sub-1" })),
    unregisterWebhook: vi.fn(async () => {}),
    verifyWebhookSignature: vi.fn(() => true),
    parseWebhookPayload: vi.fn(() => []),
    ...overrides,
  };
}

function createNonWebhookProvider() {
  return {
    id: "plain-provider",
    name: "Plain",
    validate: () => null,
    sync: vi.fn(async () => ({
      provider: "plain-provider",
      recordsSynced: 0,
      errors: [],
      duration: 0,
    })),
  };
}

const mockQueueAdd = vi.fn(async () => {});
const mockQueue = { add: mockQueueAdd };

function getMockDb() {
  return createDatabaseFromEnv();
}

function createTestApp() {
  const app = express();
  app.use(
    "/api/webhooks",
    createWebhookRouter({
      db: getMockDb(),
      syncQueue: mockQueue,
    }),
  );
  return app;
}

async function request(
  app: express.Express,
  method: "get" | "post",
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("unexpected address");
      const { port } = addr satisfies AddressInfo;
      const opts: RequestInit = { method: method.toUpperCase() };
      if (body !== undefined) {
        opts.body = body;
        opts.headers = { "content-type": "application/octet-stream", ...headers };
      }
      fetch(`http://localhost:${port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          resolve({
            status: res.status,
            body: text,
            headers: Object.fromEntries(res.headers.entries()),
          });
          server.close();
        })
        .catch((error: unknown) => {
          server.close();
          reject(error);
        });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllProviders.mockReturnValue([]);
  mockExecuteWithSchema.mockResolvedValue([]);
  mockWithUserWriteFence.mockImplementation(
    async (
      _database: unknown,
      _userId: string,
      operation: (database: typeof mockFenceTransaction) => Promise<unknown>,
    ) => operation(mockFenceTransaction),
  );
});

describe("GET /api/webhooks/:providerName — validation challenges", () => {
  it("returns 404 for unknown provider", async () => {
    const res = await request(createTestApp(), "get", "/api/webhooks/unknown");
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found");
  });

  it("returns 404 for non-webhook provider", async () => {
    mockGetAllProviders.mockReturnValue([createNonWebhookProvider()]);
    const res = await request(createTestApp(), "get", "/api/webhooks/plain-provider");
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found");
  });

  it("returns 200 OK if provider has no handleValidationChallenge", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: undefined,
    });
    mockGetAllProviders.mockReturnValue([provider]);
    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");
    expect(res.status).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("returns 404 when no active subscription exists", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: vi.fn(() => ({ challenge: "ok" })),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([]);
    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");
    expect(res.status).toBe(404);
    expect(res.body).toBe("No subscription");
  });

  it("accepts a matching pending subscription validation challenge", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: vi.fn((query, verifyToken) =>
        query["hub.verify_token"] === verifyToken ? { "hub.challenge": "challenge" } : null,
      ),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "pending-1", provider_id: null, verify_token: "pending-token", signing_secret: null },
      ]);

    const res = await request(
      createTestApp(),
      "get",
      "/api/webhooks/test-provider?hub.mode=subscribe&hub.challenge=challenge&hub.verify_token=pending-token",
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain("challenge");
  });

  it("continues through pending subscriptions until a challenge token matches", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: vi.fn((query, verifyToken) =>
        query["hub.verify_token"] === verifyToken ? { "hub.challenge": verifyToken } : null,
      ),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "pending-1", provider_id: null, verify_token: "other-token", signing_secret: null },
      { id: "pending-2", provider_id: null, verify_token: "pending-token", signing_secret: null },
    ]);

    const res = await request(
      createTestApp(),
      "get",
      "/api/webhooks/test-provider?hub.verify_token=pending-token",
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain("pending-token");
    expect(provider.handleValidationChallenge).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when challenge handler returns null", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: vi.fn(() => null),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");
    expect(res.status).toBe(400);
    expect(res.body).toBe("Challenge failed");
  });

  it("returns JSON challenge response on success", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: vi.fn(() => ({ "hub.challenge": "abc123" })),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ "hub.challenge": "abc123" });
  });

  it("accepts the matching challenge token across multiple user subscriptions", async () => {
    const challengeSpy = vi.fn((_query: Record<string, string>, verifyToken: string) =>
      verifyToken === "second-token" ? { challenge: "second-user" } : null,
    );
    const provider = createMockWebhookProvider({
      handleValidationChallenge: challengeSpy,
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "test-provider",
        verify_token: "first-token",
        signing_secret: null,
      },
      {
        id: "sub-2",
        provider_id: "test-provider",
        verify_token: "second-token",
        signing_secret: null,
      },
    ]);

    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: "second-user" });
    expect(challengeSpy).toHaveBeenCalledTimes(2);
  });

  it("stops decrypting subscriptions after a challenge token matches", async () => {
    const challengeSpy = vi.fn(() => ({ challenge: "first-user" }));
    const provider = createMockWebhookProvider({
      handleValidationChallenge: challengeSpy,
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "test-provider",
        verify_token: "first-token",
        signing_secret: null,
      },
      {
        id: "sub-2",
        provider_id: "test-provider",
        verify_token: "enc:v1:not-valid-encrypted-value",
        signing_secret: null,
      },
    ]);

    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: "first-user" });
    expect(challengeSpy).toHaveBeenCalledTimes(1);
  });

  it("passes query parameters as string values to handleValidationChallenge", async () => {
    const challengeSpy = vi.fn(() => ({ ok: true }));
    const provider = createMockWebhookProvider({
      handleValidationChallenge: challengeSpy,
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "my-token", signing_secret: null },
    ]);
    // Pass query params to verify they are stringified
    const res = await request(
      createTestApp(),
      "get",
      "/api/webhooks/test-provider?hub.mode=subscribe&hub.challenge=test-challenge&hub.verify_token=my-token",
    );
    expect(res.status).toBe(200);
    // Verify handleValidationChallenge was called with stringified query params
    expect(challengeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        "hub.mode": "subscribe",
        "hub.challenge": "test-challenge",
        "hub.verify_token": "my-token",
      }),
      "my-token",
    );
  });

  it("decrypts encrypted verify_token before challenge handling", async () => {
    const challengeSpy = vi.fn(() => ({ ok: true }));
    const provider = createMockWebhookProvider({
      handleValidationChallenge: challengeSpy,
    });
    mockGetAllProviders.mockReturnValue([provider]);
    const encryptedVerifyToken = await encryptCredentialValue("my-token", {
      tableName: "fitness.webhook_subscription",
      columnName: "verify_token",
      scopeId: "test-provider",
    });
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "test-provider",
        verify_token: encryptedVerifyToken,
        signing_secret: null,
      },
    ]);

    const res = await request(
      createTestApp(),
      "get",
      "/api/webhooks/test-provider?hub.mode=subscribe&hub.challenge=test-challenge&hub.verify_token=my-token",
    );

    expect(res.status).toBe(200);
    expect(challengeSpy).toHaveBeenCalledWith(expect.any(Object), "my-token");
  });

  it("returns 500 on internal error", async () => {
    const provider = createMockWebhookProvider({
      handleValidationChallenge: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const res = await request(createTestApp(), "get", "/api/webhooks/test-provider");
    expect(res.status).toBe(500);
    expect(res.body).toBe("Internal error");
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      {
        tags: {
          provider: "test-provider",
          webhookPhase: "validation-challenge",
        },
      },
    );
  });
});

describe("POST /api/webhooks/:providerName — event processing", () => {
  it("rate-limits only rejected requests with the configured policy", async () => {
    const app = createTestApp();
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const successfulResponse = await request(app, "post", "/api/webhooks/test-provider", "{}");
    expect(successfulResponse.status).toBe(200);

    mockGetAllProviders.mockReturnValue([]);
    for (let attempt = 0; attempt < 59; attempt++) {
      await request(app, "post", "/api/webhooks/unknown", "{}");
    }

    const finalAllowedResponse = await request(app, "post", "/api/webhooks/unknown", "{}");
    expect(finalAllowedResponse.status).toBe(404);

    const limitedResponse = await request(app, "post", "/api/webhooks/unknown", "{}");
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.body).toBe(
      "Too many rejected webhook requests — please try again later",
    );
    expect(Number(limitedResponse.headers["retry-after"])).toBeGreaterThanOrEqual(800);
    expect(limitedResponse.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("returns 404 for unknown provider", async () => {
    const res = await request(createTestApp(), "post", "/api/webhooks/unknown", "{}");
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found");
  });

  it("returns 404 for non-webhook provider", async () => {
    mockGetAllProviders.mockReturnValue([createNonWebhookProvider()]);
    const res = await request(createTestApp(), "post", "/api/webhooks/plain-provider", "{}");
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found");
  });

  it("returns 404 when no active subscription exists", async () => {
    const provider = createMockWebhookProvider();
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([]);
    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(res.status).toBe(404);
    expect(res.body).toBe("No subscription");
  });

  it("returns 401 when signature verification fails", async () => {
    const provider = createMockWebhookProvider({
      verifyWebhookSignature: vi.fn(() => false),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: "secret" },
    ]);
    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(res.status).toBe(401);
    expect(res.body).toBe("Invalid signature");
  });

  it("uses verify_token as signingSecret when signing_secret is null", async () => {
    const verifySpy = vi.fn(() => true);
    const provider = createMockWebhookProvider({
      verifyWebhookSignature: verifySpy,
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "test-provider",
        verify_token: "the-token",
        signing_secret: null,
      },
    ]);
    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(res.status).toBe(200);
    // The signingSecret passed should be "the-token" (fallback from verify_token)
    expect(verifySpy).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Object), "the-token");
  });

  it("accepts the matching signing secret across multiple user subscriptions", async () => {
    const verifySpy = vi.fn(
      (_body: Buffer, _headers: Record<string, string>, signingSecret: string) =>
        signingSecret === "second-secret",
    );
    const provider = createMockWebhookProvider({
      verifyWebhookSignature: verifySpy,
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "test-provider",
        verify_token: "first-token",
        signing_secret: "first-secret",
      },
      {
        id: "sub-2",
        provider_id: "test-provider",
        verify_token: "second-token",
        signing_secret: "second-secret",
      },
    ]);

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");

    expect(res.status).toBe(200);
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it("stops decrypting subscriptions after a signing secret matches", async () => {
    const verifySpy = vi.fn(() => true);
    const provider = createMockWebhookProvider({
      verifyWebhookSignature: verifySpy,
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "test-provider",
        verify_token: "first-token",
        signing_secret: "first-secret",
      },
      {
        id: "sub-2",
        provider_id: "test-provider",
        verify_token: "second-token",
        signing_secret: "enc:v1:not-valid-encrypted-value",
      },
    ]);

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");

    expect(res.status).toBe(200);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid JSON body", async () => {
    const provider = createMockWebhookProvider();
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const res = await request(
      createTestApp(),
      "post",
      "/api/webhooks/test-provider",
      "not-json{{{",
    );
    expect(res.status).toBe(400);
    expect(res.body).toBe("Invalid JSON");
  });

  it("returns 400 when parseWebhookPayload throws", async () => {
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => {
        throw new Error("bad payload");
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"data":1}');
    expect(res.status).toBe(400);
    expect(res.body).toBe("Invalid payload");
  });

  it("returns 200 OK with no events", async () => {
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "test-provider", verify_token: "tok", signing_secret: null },
    ]);
    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(res.status).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("enqueues full sync when events have no syncWebhookEvent", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    // First call: subscription lookup; second call: user lookup
    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      return [{ provider_id: "prov-1", user_id: "user-1" }];
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(res.status).toBe(200);
    expect(mockEnqueueSyncJob).toHaveBeenCalledWith("prov-1", {
      origin: "manual",
      providerId: "prov-1",
      sinceDays: 1,
      userId: "user-1",
    });
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(
      expect.any(Object),
      "user-1",
      expect.any(Function),
    );
  });

  it("does not enqueue when the resolved user's account-erasure fence rejects", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema
      .mockResolvedValueOnce([
        {
          id: "sub-1",
          provider_id: "prov-1",
          verify_token: "tok",
          signing_secret: null,
        },
      ])
      .mockResolvedValueOnce([{ provider_id: "prov-1", user_id: "user-1" }]);
    mockWithUserWriteFence.mockRejectedValueOnce(new Error("Account erasure is active"));

    const response = await request(
      createTestApp(),
      "post",
      "/api/webhooks/test-provider",
      '{"x":1}',
    );

    expect(response.status).toBe(503);
    expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
  });

  it("calls syncWebhookEvent for targeted sync when available", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const syncWebhookEvent = vi.fn(async () => ({
      provider: "test-provider",
      recordsSynced: 1,
      errors: [],
      duration: 42,
    }));
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
      syncWebhookEvent,
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      return [{ provider_id: "prov-1", user_id: "user-1" }];
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(res.status).toBe(200);
    expect(syncWebhookEvent).toHaveBeenCalledWith(expect.anything(), events[0], {
      userId: "user-1",
    });
    // Should NOT enqueue full sync
    expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
  });

  it("falls back to full sync when syncWebhookEvent fails", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const syncWebhookEvent = vi.fn(async () => {
      throw new Error("targeted sync failed");
    });
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
      syncWebhookEvent,
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      return [{ provider_id: "prov-1", user_id: "user-1" }];
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(res.status).toBe(200);
    expect(mockEnqueueSyncJob).toHaveBeenCalledWith("prov-1", {
      origin: "manual",
      providerId: "prov-1",
      sinceDays: 1,
      userId: "user-1",
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "targeted sync failed" }),
      {
        tags: {
          provider: "test-provider",
          webhookEventType: "create",
          webhookObjectType: "activity",
          webhookPhase: "targeted-sync",
        },
      },
    );
  });

  it("skips events when no user found for external ID", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "unknown-ext", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      return []; // No user found
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(res.status).toBe(200);
    expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
  });

  it("returns 503 after a database failure while still processing remaining events", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
      { ownerExternalId: "ext-2", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      if (callCount === 2) {
        throw new Error("DB error on first event");
      }
      return [{ provider_id: "prov-2", user_id: "user-2" }];
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(res.status).toBe(503);
    expect(res.body).toBe("Retry later");
    // Second event should still have been processed
    expect(mockEnqueueSyncJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSyncJob).toHaveBeenCalledWith("prov-2", {
      origin: "manual",
      providerId: "prov-2",
      sinceDays: 1,
      userId: "user-2",
    });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "DB error on first event" }),
      {
        tags: {
          provider: "test-provider",
          webhookEventType: "create",
          webhookObjectType: "activity",
          webhookPhase: "event-processing",
        },
      },
    );
  });

  it("returns 503 and reports an unexpected top-level error", async () => {
    // Force ensureProvidersRegistered to throw
    const { ensureProvidersRegistered } = await import("../routers/sync-helpers.ts");
    vi.mocked(ensureProvidersRegistered).mockRejectedValueOnce(new Error("boom"));

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(res.status).toBe(503);
    expect(res.body).toBe("Retry later");
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      {
        tags: {
          provider: "test-provider",
          webhookPhase: "request-processing",
        },
      },
    );
  });

  it("returns 503 and reports event context when enqueueing fails", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      return [{ provider_id: "prov-1", user_id: "user-1" }];
    });
    mockEnqueueSyncJob.mockRejectedValueOnce(new Error("Redis unavailable"));

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');

    expect(res.status).toBe(503);
    expect(res.body).toBe("Retry later");
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Redis unavailable" }),
      {
        tags: {
          provider: "test-provider",
          webhookEventType: "create",
          webhookObjectType: "activity",
          webhookPhase: "event-processing",
        },
      },
    );
  });

  it("acknowledges a fenced account without emitting stable identifiers", async () => {
    const events: WebhookEvent[] = [
      {
        ownerExternalId: "stable-external-account-id",
        eventType: "create",
        objectType: "activity",
      },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "subscription-secret-id", provider_id: "provider-row", verify_token: "tok" }];
      }
      return [{ provider_id: "provider-row", user_id: "stable-user-id" }];
    });
    mockWithUserWriteFence.mockRejectedValueOnce(new MockAccountErasureUserFencedError());

    const res = await request(
      createTestApp(),
      "post",
      "/api/webhooks/test-provider",
      '{"message":"private workout details"}',
    );

    expect(res.status).toBe(200);
    expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    const emittedLogs = JSON.stringify(
      Object.values(mockLogger).flatMap((mock) => mock.mock.calls),
    );
    expect(emittedLogs).not.toContain("stable-external-account-id");
    expect(emittedLogs).not.toContain("stable-user-id");
    expect(emittedLogs).not.toContain("subscription-secret-id");
    expect(emittedLogs).not.toContain("private workout details");
  });

  it("enqueues sync job with exact shape (providerId, sinceDays, userId)", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-99", eventType: "update", objectType: "sleep" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-X", verify_token: "tok", signing_secret: null }];
      }
      return [{ provider_id: "prov-X", user_id: "user-X" }];
    });

    await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(mockEnqueueSyncJob).toHaveBeenCalledTimes(1);
    const [providerId, jobData] = mockEnqueueSyncJob.mock.calls[0] ?? [];
    expect(providerId).toBe("prov-X");
    expect(jobData).toEqual({
      origin: "manual",
      providerId: "prov-X",
      sinceDays: 1,
      userId: "user-X",
    });
  });

  it("uses signing_secret when present (not verify_token)", async () => {
    const verifySpy = vi.fn(() => true);
    const provider = createMockWebhookProvider({
      verifyWebhookSignature: verifySpy,
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      {
        id: "sub-1",
        provider_id: "prov-1",
        verify_token: "should-not-use",
        signing_secret: "should-use-this",
      },
    ]);
    await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(verifySpy).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(Object),
      "should-use-this",
    );
  });

  it("processes multiple events from same payload", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
      { ownerExternalId: "ext-2", eventType: "update", objectType: "sleep" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      if (callCount === 2) {
        return [{ provider_id: "prov-1", user_id: "user-1" }];
      }
      return [{ provider_id: "prov-2", user_id: "user-2" }];
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "[]");
    expect(res.status).toBe(200);
    expect(mockEnqueueSyncJob).toHaveBeenCalledTimes(2);
  });

  it("uses signing_secret when available instead of verify_token", async () => {
    const verifySpy = vi.fn(() => true);
    const provider = createMockWebhookProvider({
      verifyWebhookSignature: verifySpy,
      parseWebhookPayload: vi.fn(() => []),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockExecuteWithSchema.mockResolvedValue([
      { id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: "my-secret" },
    ]);
    await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(verifySpy).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Object), "my-secret");
  });
});

describe("registerWebhookForProvider", () => {
  beforeEach(() => {
    mockExecuteWithSchema.mockResolvedValue([{ id: "pending-1" }]);
  });

  it("skips registration when app-level subscription already exists", async () => {
    const provider = createMockWebhookProvider({ webhookScope: "app" });
    mockExecuteWithSchema.mockResolvedValue([{ id: "existing-sub" }]);

    await registerWebhookForProvider(getMockDb(), provider, "user-1");
    expect(provider.registerWebhook).not.toHaveBeenCalled();
  });

  it("registers webhook and inserts subscription for new app-level provider", async () => {
    const db = getMockDb();
    const provider = createMockWebhookProvider({
      webhookScope: "app",
      registerWebhook: vi.fn(async () => ({
        subscriptionId: "new-sub",
        signingSecret: "secret-123",
      })),
    });
    mockExecuteWithSchema.mockResolvedValueOnce([]); // No existing subscription

    await registerWebhookForProvider(db, provider, "user-1");
    expect(provider.registerWebhook).toHaveBeenCalledWith(
      expect.stringContaining("/api/webhooks/test-provider"),
      expect.any(String),
    );
    const query = new PgDialect().sqlToQuery(mockExecuteWithSchema.mock.calls[1]?.[2]);
    expect(query.sql).toContain("status = 'active'");
    expect(query.sql).toContain("subscription_external_id");
    expect(query.params).not.toContain("user-1");
  });

  it("registers webhook for per-user provider without checking for existing", async () => {
    const db = getMockDb();
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "user-sub" })),
    });

    await registerWebhookForProvider(db, provider, "user-1");
    expect(provider.registerWebhook).toHaveBeenCalled();
    const pendingQuery = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]?.[0]);
    expect(pendingQuery.sql).toContain("'pending'");
    expect(pendingQuery.params).toContain("user-1");
    expect(pendingQuery.params).toContain("test-provider");
    expect(
      pendingQuery.params.some(
        (param) => typeof param === "string" && param.includes('"callbackUrl"'),
      ),
    ).toBe(true);

    const activationQuery = new PgDialect().sqlToQuery(mockExecuteWithSchema.mock.calls[0]?.[2]);
    expect(activationQuery.sql).toContain("status = 'active'");
    expect(activationQuery.params).toContain("user-sub");
  });

  it("uses PUBLIC_URL env var for callback URL", async () => {
    const originalUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://my-custom-domain.com";

    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "sub-1" })),
    });

    await registerWebhookForProvider(getMockDb(), provider, "user-1");
    expect(provider.registerWebhook).toHaveBeenCalledWith(
      "https://my-custom-domain.com/api/webhooks/test-provider",
      expect.any(String),
    );

    process.env.PUBLIC_URL = originalUrl;
  });

  it("uses default PUBLIC_URL when env var is not set", async () => {
    const originalUrl = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;

    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "sub-1" })),
    });

    await registerWebhookForProvider(getMockDb(), provider, "user-1");
    expect(provider.registerWebhook).toHaveBeenCalledWith(
      "https://dofek.fit/api/webhooks/test-provider",
      expect.any(String),
    );

    process.env.PUBLIC_URL = originalUrl;
  });

  it("passes a 64-character hex verify token", async () => {
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "sub-1" })),
    });

    await registerWebhookForProvider(getMockDb(), provider, "user-1");
    const verifyToken = vi.mocked(provider.registerWebhook).mock.calls[0]?.[1];
    // 32 random bytes = 64 hex characters
    expect(verifyToken).toHaveLength(64);
    expect(verifyToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not check for existing subscription when webhookScope is 'user'", async () => {
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "user-sub" })),
    });

    await registerWebhookForProvider(getMockDb(), provider, "user-1");
    // For user-scoped webhooks, executeWithSchema should NOT be called to check existing
    // (it's only called for app-scoped)
    expect(provider.registerWebhook).toHaveBeenCalled();
  });

  it("checks for existing subscription when webhookScope is 'app'", async () => {
    const provider = createMockWebhookProvider({
      webhookScope: "app",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "new-sub" })),
    });

    // No existing subscription
    mockExecuteWithSchema.mockResolvedValueOnce([]);

    await registerWebhookForProvider(getMockDb(), provider, "user-1");
    // Should call executeWithSchema to check for existing, then call registerWebhook
    expect(mockExecuteWithSchema).toHaveBeenCalled();
    expect(provider.registerWebhook).toHaveBeenCalled();
  });

  it("calls db.execute to insert the subscription row after registration", async () => {
    const db = getMockDb();
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({
        subscriptionId: "new-sub-123",
        signingSecret: "my-secret",
      })),
    });

    await registerWebhookForProvider(db, provider, "user-1");
    expect(db.execute).toHaveBeenCalled();
  });

  it("does not create a remote webhook when pending subscription persistence fails", async () => {
    const db = getMockDb();
    vi.mocked(db.execute).mockRejectedValueOnce(new Error("database unavailable"));
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "orphan-sub" })),
      unregisterWebhook: vi.fn(async () => undefined),
    });

    await expect(registerWebhookForProvider(db, provider, "user-1")).rejects.toThrow(
      "database unavailable",
    );

    expect(provider.registerWebhook).not.toHaveBeenCalled();
    expect(provider.unregisterWebhook).not.toHaveBeenCalled();
  });

  it("removes the pending row when remote webhook registration fails", async () => {
    const db = getMockDb();
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    await expect(registerWebhookForProvider(db, provider, "user-1")).rejects.toThrow(
      "provider unavailable",
    );

    expect(db.execute).toHaveBeenCalledTimes(2);
    const cleanupQuery = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[1]?.[0]);
    expect(cleanupQuery.sql).toContain("DELETE FROM fitness.webhook_subscription");
    expect(cleanupQuery.sql).toContain("status = 'pending'");
  });

  it("reports pending-row cleanup failure when remote registration fails", async () => {
    const db = getMockDb();
    let executeCount = 0;
    vi.mocked(db.execute).mockImplementation(async () => {
      executeCount += 1;
      if (executeCount === 2) throw new Error("cleanup unavailable");
      return [{ id: "pending-1" }];
    });
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    await expect(registerWebhookForProvider(db, provider, "user-1")).rejects.toThrow(
      "provider unavailable",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cleanup unavailable" }),
      expect.objectContaining({
        tags: { provider: "test-provider", webhookPhase: "pending-subscription-cleanup" },
      }),
    );
  });

  it("reports pending-row cleanup failure when activation fails", async () => {
    const db = getMockDb();
    let executeCount = 0;
    vi.mocked(db.execute).mockImplementation(async () => {
      executeCount += 1;
      if (executeCount === 2) throw new Error("cleanup unavailable");
      return [{ id: "pending-1" }];
    });
    mockExecuteWithSchema.mockResolvedValue([]);
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "remote-sub" })),
    });

    await expect(registerWebhookForProvider(db, provider, "user-1")).rejects.toThrow(
      "Pending webhook subscription was not found",
    );
    expect(provider.unregisterWebhook).toHaveBeenCalledWith("remote-sub");
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cleanup unavailable" }),
      expect.objectContaining({
        tags: { provider: "test-provider", webhookPhase: "pending-subscription-cleanup" },
      }),
    );
  });
});
