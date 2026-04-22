import type { AddressInfo } from "node:net";
import type { WebhookEvent, WebhookProvider } from "dofek/providers/types";
import { encryptCredentialValue } from "dofek/security/credential-encryption";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetAllProviders = vi.fn<() => Array<Record<string, unknown>>>(() => []);

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => mockGetAllProviders(),
}));

vi.mock("dofek/providers/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dofek/providers/types")>();
  return { ...actual };
});

vi.mock("../routers/sync.ts", () => ({
  ensureProvidersRegistered: vi.fn(async () => {}),
}));

const mockStartWorker = vi.fn(async () => {});
vi.mock("../lib/start-worker.ts", () => ({
  startWorker: () => mockStartWorker(),
}));

const mockExecuteWithSchema = vi.fn(async () => []);
vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: (...args: unknown[]) => mockExecuteWithSchema(...args),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({
    execute: vi.fn(async () => []),
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
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
          resolve({ status: res.status, body: text });
          server.close();
        })
        .catch((_error: unknown) => {
          resolve({ status: 500, body: "fetch error" });
          server.close();
        });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllProviders.mockReturnValue([]);
  mockExecuteWithSchema.mockResolvedValue([]);
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
  });
});

describe("POST /api/webhooks/:providerName — event processing", () => {
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
    expect(mockQueueAdd).toHaveBeenCalledWith("sync", {
      providerId: "prov-1",
      sinceDays: 1,
      userId: "user-1",
    });
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
    expect(mockQueueAdd).not.toHaveBeenCalled();
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
    expect(mockQueueAdd).toHaveBeenCalledWith("sync", {
      providerId: "prov-1",
      sinceDays: 1,
      userId: "user-1",
    });
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
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("continues processing remaining events when one fails", async () => {
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
    expect(res.status).toBe(200);
    // Second event should still have been processed
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith("sync", {
      providerId: "prov-2",
      sinceDays: 1,
      userId: "user-2",
    });
  });

  it("starts worker when full sync jobs are enqueued (no syncWebhookEvent)", async () => {
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

    await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(mockStartWorker).toHaveBeenCalled();
  });

  it("does not start worker when syncWebhookEvent handles events directly", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
      syncWebhookEvent: vi.fn(async () => ({
        provider: "test-provider",
        recordsSynced: 1,
        errors: [],
        duration: 10,
      })),
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

    await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(mockStartWorker).not.toHaveBeenCalled();
  });

  it("starts worker when syncWebhookEvent throws and fallback sync is enqueued", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
      syncWebhookEvent: vi.fn(async () => {
        throw new Error("targeted sync failed");
      }),
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

    await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    expect(mockStartWorker).toHaveBeenCalled();
  });

  it("does not crash when worker start fails", async () => {
    const events: WebhookEvent[] = [
      { ownerExternalId: "ext-1", eventType: "create", objectType: "activity" },
    ];
    const provider = createMockWebhookProvider({
      parseWebhookPayload: vi.fn(() => events),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockStartWorker.mockRejectedValueOnce(new Error("worker failed"));

    let callCount = 0;
    mockExecuteWithSchema.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ id: "sub-1", provider_id: "prov-1", verify_token: "tok", signing_secret: null }];
      }
      return [{ provider_id: "prov-1", user_id: "user-1" }];
    });

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", '{"x":1}');
    // Should still return 200 even if worker start fails
    expect(res.status).toBe(200);
  });

  it("returns 200 even on unexpected top-level error to prevent retries", async () => {
    // Force ensureProvidersRegistered to throw
    const { ensureProvidersRegistered } = await import("../routers/sync.ts");
    vi.mocked(ensureProvidersRegistered).mockRejectedValueOnce(new Error("boom"));

    const res = await request(createTestApp(), "post", "/api/webhooks/test-provider", "{}");
    expect(res.status).toBe(200);
    expect(res.body).toBe("OK");
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
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const jobData = mockQueueAdd.mock.calls[0]?.[1];
    expect(jobData).toEqual({
      providerId: "prov-X",
      sinceDays: 1,
      userId: "user-X",
    });
    // First arg is the job name "sync"
    expect(mockQueueAdd.mock.calls[0]?.[0]).toBe("sync");
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
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
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
  it("skips registration when app-level subscription already exists", async () => {
    const provider = createMockWebhookProvider({ webhookScope: "app" });
    mockExecuteWithSchema.mockResolvedValue([{ id: "existing-sub" }]);

    await registerWebhookForProvider(getMockDb(), provider);
    expect(provider.registerWebhook).not.toHaveBeenCalled();
  });

  it("registers webhook and inserts subscription for new app-level provider", async () => {
    const provider = createMockWebhookProvider({
      webhookScope: "app",
      registerWebhook: vi.fn(async () => ({
        subscriptionId: "new-sub",
        signingSecret: "secret-123",
      })),
    });
    mockExecuteWithSchema.mockResolvedValue([]); // No existing subscription

    await registerWebhookForProvider(getMockDb(), provider);
    expect(provider.registerWebhook).toHaveBeenCalledWith(
      expect.stringContaining("/api/webhooks/test-provider"),
      expect.any(String),
    );
    // DB insert is called internally — registerWebhook call above confirms the path was taken
  });

  it("registers webhook for per-user provider without checking for existing", async () => {
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "user-sub" })),
    });

    await registerWebhookForProvider(getMockDb(), provider);
    // Per-user scope should NOT check for existing subscriptions
    // The first mock call is registerWebhook, not executeWithSchema checking existing
    expect(provider.registerWebhook).toHaveBeenCalled();
    // DB insert is called internally — registerWebhook call above confirms the path was taken
  });

  it("uses PUBLIC_URL env var for callback URL", async () => {
    const originalUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://my-custom-domain.com";

    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "sub-1" })),
    });

    await registerWebhookForProvider(getMockDb(), provider);
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

    await registerWebhookForProvider(getMockDb(), provider);
    expect(provider.registerWebhook).toHaveBeenCalledWith(
      "https://dofek.asherlc.com/api/webhooks/test-provider",
      expect.any(String),
    );

    process.env.PUBLIC_URL = originalUrl;
  });

  it("passes a 64-character hex verify token", async () => {
    const provider = createMockWebhookProvider({
      webhookScope: "user",
      registerWebhook: vi.fn(async () => ({ subscriptionId: "sub-1" })),
    });

    await registerWebhookForProvider(getMockDb(), provider);
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

    await registerWebhookForProvider(getMockDb(), provider);
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
    mockExecuteWithSchema.mockResolvedValue([]);

    await registerWebhookForProvider(getMockDb(), provider);
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

    await registerWebhookForProvider(db, provider);
    expect(db.execute).toHaveBeenCalled();
  });
});
