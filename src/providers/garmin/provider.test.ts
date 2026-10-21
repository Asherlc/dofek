import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { createMockDatabase } from "../test-helpers.ts";
import type { WebhookEvent } from "../types.ts";

const mocks = vi.hoisted(() => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
  deleteProviderAuthorization: vi.fn(),
  state: vi.fn(),
  health: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("../../db/tokens.ts", () => ({
  loadTokens: mocks.loadTokens,
  saveTokens: mocks.saveTokens,
  deleteProviderAuthorization: mocks.deleteProviderAuthorization,
}));
vi.mock("./authorization.ts", () => ({
  readGarminDeliveryState: mocks.state,
  assertGarminAuthorizationOwner: vi.fn(),
}));
vi.mock("./health.ts", () => ({ syncGarminHealthRecord: mocks.health }));
vi.mock("./activities.ts", () => ({ syncGarminActivityRecord: mocks.activity }));
vi.mock("../../provider-artifact-storage.ts", () => ({
  createProviderArtifactStorageFromEnv: () => ({
    ensureArtifact: vi.fn(),
    materializeArtifact: vi.fn(),
    deleteForUser: vi.fn(),
    deleteForProvider: vi.fn(),
  }),
}));
vi.mock("../../lib/provider-rate-limit-fetch.ts", () => ({
  createProviderRateLimitFetch: (_id: string, fetchFn: typeof fetch) => fetchFn,
}));

import { GarminProvider } from "./provider.ts";

const grantId = "30000000-0000-4000-8000-000000000001";
const owner = "stable-owner";
function authorization(): TokenSet {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 60_000),
    providerAccountId: owner,
    authorizationId: grantId,
    scopes: "HEALTH_EXPORT ACTIVITY_EXPORT",
  };
}
function event(objectType = "dailies", overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    ownerExternalId: owner,
    eventType: "update",
    objectType,
    objectId: "summary",
    metadata: {
      payload: { userId: owner, summaryId: "summary" },
      authorizationId: grantId,
      providerDataGeneration: 0,
    },
    ...overrides,
  };
}
describe("official Garmin provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GARMIN_CLIENT_ID", "client");
    vi.stubEnv("GARMIN_CLIENT_SECRET", "secret");
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "a".repeat(64));
    mocks.loadTokens.mockResolvedValue(authorization());
    mocks.state.mockResolvedValue({ generation: 0, pendingDeletion: false });
    mocks.health.mockResolvedValue(1);
    mocks.activity.mockResolvedValue(1);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("offers official OAuth and validates receiving credentials", () => {
    const provider = new GarminProvider();
    expect(provider.pushOnly).toBe(true);
    expect(provider.validate()).toBeNull();
    expect(provider.authSetup()?.oauthConfig?.usePkce).toBe(true);
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "");
    expect(provider.validate()).toContain("GARMIN_WEBHOOK_SECRET");
  });
  it("writes an owned notification using the shared health pipeline", async () => {
    const { db } = createMockDatabase();
    const incoming = event();
    const options = { userId: "dofek-owner" };
    const provider = new GarminProvider(vi.fn<typeof fetch>());
    await expect(provider.syncWebhookEvent(db, incoming, options)).resolves.toMatchObject({
      provider: "garmin",
      recordsSynced: 1,
      errors: [],
    });
    expect(mocks.health).toHaveBeenCalledWith(db, "dailies", incoming.metadata?.payload, options);
  });
  it.each([
    null,
    { ...authorization(), providerAccountId: "someone-else" },
    { ...authorization(), authorizationId: "another-grant" },
  ])("discards stale or disconnected deliveries", async (tokens) => {
    mocks.loadTokens.mockResolvedValue(tokens);
    const { db } = createMockDatabase();
    const provider = new GarminProvider();
    expect((await provider.syncWebhookEvent(db, event(), { userId: "owner" })).recordsSynced).toBe(
      0,
    );
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it("discards a delivery received before a data deletion", async () => {
    mocks.state.mockResolvedValue({ generation: 1, pendingDeletion: false });
    const { db } = createMockDatabase();
    expect(
      (await new GarminProvider().syncWebhookEvent(db, event(), { userId: "owner" })).recordsSynced,
    ).toBe(0);
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it("retries new deliveries while deletion is still removing artifacts", async () => {
    mocks.state.mockResolvedValue({ generation: 0, pendingDeletion: true });
    const { db } = createMockDatabase();
    await expect(
      new GarminProvider().syncWebhookEvent(db, event(), { userId: "owner" }),
    ).rejects.toThrow("deletion");
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it("honors the current permission set before ingesting an older queued feed", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), scopes: "ACTIVITY_EXPORT" });
    const { db } = createMockDatabase();
    expect(
      (await new GarminProvider().syncWebhookEvent(db, event(), { userId: "owner" })).recordsSynced,
    ).toBe(0);
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it("refreshes and persists rotating tokens before a FIT callback", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
      }),
    );
    const { db } = createMockDatabase();
    await new GarminProvider(fetchFn).syncWebhookEvent(db, event("activityFiles"), {
      userId: "owner",
    });
    expect(mocks.saveTokens).toHaveBeenCalledWith(
      db,
      "garmin",
      expect.objectContaining({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        authorizationId: grantId,
        providerAccountId: owner,
        scopes: "HEALTH_EXPORT ACTIVITY_EXPORT",
      }),
      "owner",
    );
    expect(mocks.activity).toHaveBeenCalledWith(
      db,
      "activityFiles",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ accessToken: "new-access" }),
    );
  });
  it("refreshes permissions from Garmin rather than applying delayed permission payloads", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ permissions: ["ACTIVITY_EXPORT"] }));
    const { db } = createMockDatabase();
    await new GarminProvider(fetchFn).syncWebhookEvent(db, event("userPermissionsChange"), {
      userId: "owner",
    });
    expect(mocks.saveTokens).toHaveBeenCalledWith(
      db,
      "garmin",
      expect.objectContaining({ scopes: "ACTIVITY_EXPORT" }),
      "owner",
    );
    expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
  });
  it("keeps a fresh grant when a prior registration's deregistration arrives late", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ permissions: ["HEALTH_EXPORT"] }));
    const { db } = createMockDatabase();
    await new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
      userId: "owner",
    });
    expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
  });
  it("removes revoked authorization while preserving history", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const { db } = createMockDatabase();
    await new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
      userId: "owner",
    });
    expect(mocks.deleteProviderAuthorization).toHaveBeenCalledWith(db, "garmin", "owner");
    expect(mocks.health).not.toHaveBeenCalled();
  });

  it("removes an expired revoked grant when Garmin confirms invalid_grant during refresh", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const { db } = createMockDatabase();
    await new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
      userId: "owner",
    });
    expect(mocks.deleteProviderAuthorization).toHaveBeenCalledWith(db, "garmin", "owner");
  });

  it("retains authorization and retries deregistration reconciliation after a token service outage", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "server_error" }, { status: 503 }));
    const { db } = createMockDatabase();
    await expect(
      new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
        userId: "owner",
      }),
    ).rejects.toThrow("503");
    expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
  });
});
