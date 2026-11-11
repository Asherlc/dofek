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
    retainFile: vi.fn().mockResolvedValue("retained.fit"),
    hasForProvider: vi.fn().mockResolvedValue(false),
    ensureArtifact: vi.fn(),
    materializeArtifact: vi.fn(),
    deleteForUser: vi.fn(),
    deleteForProvider: vi.fn(),
  }),
}));
vi.mock("../../lib/provider-rate-limit-fetch.ts", () => ({
  createProviderRateLimitFetch: (_id: string, fetchFn: typeof fetch) => fetchFn,
}));

let GarminProvider: typeof import("./provider.ts").GarminProvider;

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
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.stubEnv("GARMIN_CLIENT_ID", "client");
    vi.stubEnv("GARMIN_CLIENT_SECRET", "secret");
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "a".repeat(64));
    mocks.loadTokens.mockResolvedValue(authorization());
    mocks.state.mockResolvedValue({ generation: 0, pendingDeletion: false });
    mocks.health.mockResolvedValue(1);
    mocks.activity.mockResolvedValue(1);
    ({ GarminProvider } = await import("./provider.ts"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["GARMIN_CLIENT_ID", "GARMIN_CLIENT_SECRET"])(
    "reports missing or whitespace-only %s before offering OAuth",
    (key) => {
      const provider = new GarminProvider();
      for (const value of [undefined, "", " \t "]) {
        vi.stubEnv(key, value);
        expect(provider.validate()).toContain(key);
        expect(provider.authSetup()).toBeUndefined();
      }
    },
  );

  it("accepts the exact 32-byte webhook secret boundary and rejects shorter secrets", () => {
    const provider = new GarminProvider();
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "a".repeat(32));
    expect(provider.validate()).toBeNull();
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "a".repeat(31));
    expect(provider.validate()).toContain("GARMIN_WEBHOOK_SECRET");
  });

  it.each([undefined, "", " \t "])(
    "requires an explicit nonempty notification userId (%j)",
    async (userId) => {
      const { db } = createMockDatabase();
      await expect(
        new GarminProvider().syncWebhookEvent(db, event(), userId === undefined ? {} : { userId }),
      ).rejects.toThrow("requires userId");
      expect(mocks.loadTokens).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { authorizationId: "invalid", providerDataGeneration: 0, payload: {} },
    { authorizationId: grantId, providerDataGeneration: -1, payload: {} },
    { authorizationId: grantId, providerDataGeneration: 0, payload: [] },
  ])("rejects malformed durable notification metadata before token lookup", async (metadata) => {
    const { db } = createMockDatabase();
    await expect(
      new GarminProvider().syncWebhookEvent(db, event("dailies", { metadata }), {
        userId: "owner",
      }),
    ).rejects.toThrow();
    expect(mocks.loadTokens).not.toHaveBeenCalled();
  });

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
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(1100);
    const provider = new GarminProvider(vi.fn<typeof fetch>());
    await expect(provider.syncWebhookEvent(db, incoming, options)).resolves.toMatchObject({
      provider: "garmin",
      recordsSynced: 1,
      errors: [],
      duration: 100,
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
    expect(fetchFn).toHaveBeenCalledWith(
      "https://apis.garmin.com/partner-gateway/rest/user/permissions",
      { headers: { Authorization: "Bearer access" } },
    );
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
  it.each([401, 403])("removes revoked authorization after permissions HTTP %i", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
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

  it.each(["dailies", "sleeps", "hrv", "pulseox", "allDayRespiration"])(
    "routes the supported %s health feed with original payload and options",
    async (type) => {
      const { db } = createMockDatabase();
      const incoming = event(type);
      const options = { userId: "owner" };
      await new GarminProvider().syncWebhookEvent(db, incoming, options);
      expect(mocks.health).toHaveBeenCalledWith(db, type, incoming.metadata?.payload, options);
      expect(mocks.activity).not.toHaveBeenCalled();
    },
  );

  it.each(["activities", "manuallyUpdatedActivities", "activityFiles"])(
    "passes the %s feed its current token, artifacts, fetch, payload and options",
    async (type) => {
      const { db } = createMockDatabase();
      const artifacts = {
        retainFile: vi.fn().mockResolvedValue("retained.fit"),
        hasForProvider: vi.fn().mockResolvedValue(false),
        ensureArtifact: vi.fn(),
        materializeArtifact: vi.fn(),
        deleteForUser: vi.fn(),
        deleteForProvider: vi.fn(),
      };
      const fetchFn = vi.fn<typeof fetch>();
      const incoming = event(type);
      const options = { userId: "owner" };
      await new GarminProvider(fetchFn, () => artifacts).syncWebhookEvent(db, incoming, options);
      expect(mocks.activity).toHaveBeenCalledWith(db, type, incoming.metadata?.payload, options, {
        artifacts,
        fetchFn,
        accessToken: "access",
      });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mocks.health).not.toHaveBeenCalled();
    },
  );

  it.each(["activities", "manuallyUpdatedActivities"])(
    "ingests %s summaries without refreshing credentials needed only for a FIT download",
    async (type) => {
      mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
      const fetchFn = vi.fn<typeof fetch>();
      const { db } = createMockDatabase();
      expect(
        (await new GarminProvider(fetchFn).syncWebhookEvent(db, event(type), { userId: "owner" }))
          .recordsSynced,
      ).toBe(1);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mocks.saveTokens).not.toHaveBeenCalled();
      expect(mocks.activity).toHaveBeenCalledWith(
        db,
        type,
        event(type).metadata?.payload,
        { userId: "owner" },
        expect.objectContaining({ accessToken: "access" }),
      );
    },
  );

  it.each([null, "HEALTH_EXPORT"])(
    "skips activity ingestion without activity permission (%j)",
    async (scopes) => {
      mocks.loadTokens.mockResolvedValue({ ...authorization(), scopes });
      const { db } = createMockDatabase();
      const artifacts = vi.fn();
      expect(
        (
          await new GarminProvider(vi.fn<typeof fetch>(), artifacts).syncWebhookEvent(
            db,
            event("activityFiles"),
            { userId: "owner" },
          )
        ).recordsSynced,
      ).toBe(0);
      expect(mocks.activity).not.toHaveBeenCalled();
      expect(artifacts).not.toHaveBeenCalled();
    },
  );

  it("skips health ingestion when no permissions remain", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), scopes: null });
    const { db } = createMockDatabase();
    expect(
      (await new GarminProvider().syncWebhookEvent(db, event(), { userId: "owner" })).recordsSynced,
    ).toBe(0);
    expect(mocks.health).not.toHaveBeenCalled();
  });

  it("fails explicitly for an unsupported durable feed", async () => {
    const { db } = createMockDatabase();
    await expect(
      new GarminProvider().syncWebhookEvent(db, event("unsupportedFeed"), { userId: "owner" }),
    ).rejects.toThrow("Unsupported Garmin notification: unsupportedFeed");
  });

  it("refreshes a token exactly at its expiration boundary", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(now) });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "boundary-access",
        refresh_token: "boundary-refresh",
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
      expect.objectContaining({ accessToken: "boundary-access" }),
      "owner",
    );
  });

  it.each(["configuration", "refresh token"])(
    "requires %s before refreshing a notification token",
    async (missing) => {
      mocks.loadTokens.mockResolvedValue({
        ...authorization(),
        expiresAt: new Date(0),
        ...(missing === "refresh token" ? { refreshToken: null } : {}),
      });
      if (missing === "configuration") vi.stubEnv("GARMIN_CLIENT_ID", undefined);
      const fetchFn = vi.fn<typeof fetch>();
      const { db } = createMockDatabase();
      await expect(
        new GarminProvider(fetchFn).syncWebhookEvent(db, event("activityFiles"), {
          userId: "owner",
        }),
      ).rejects.toThrow("Reconnect Garmin");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("propagates a revoked refresh grant for a permission-change notification", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const { db } = createMockDatabase();
    await expect(
      new GarminProvider(fetchFn).syncWebhookEvent(db, event("userPermissionsChange"), {
        userId: "owner",
      }),
    ).rejects.toMatchObject({ authFailureReason: "refresh_token_revoked" });
    expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500])(
    "retains authorization when permission-change reconciliation returns HTTP %i",
    async (status) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      const { db } = createMockDatabase();
      await expect(
        new GarminProvider(fetchFn).syncWebhookEvent(db, event("userPermissionsChange"), {
          userId: "owner",
        }),
      ).rejects.toThrow(`permissions request failed (${status})`);
      expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
      expect(mocks.saveTokens).not.toHaveBeenCalled();
    },
  );

  it.each([404, 500])(
    "retains authorization when deregistration consent lookup returns HTTP %i",
    async (status) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      const { db } = createMockDatabase();
      await expect(
        new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
          userId: "owner",
        }),
      ).rejects.toThrow(`permissions request failed (${status})`);
      expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
    },
  );

  it("does not interpret invalid_grant in a successful token response as confirmed revocation", async () => {
    mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "invalid_grant" }));
    const { db } = createMockDatabase();
    await expect(
      new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
        userId: "owner",
      }),
    ).rejects.toThrow();
    expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
  });

  it.each(["text/plain", null])(
    "preserves the HTTP refresh failure for a non-JSON response (%j)",
    async (contentType) => {
      mocks.loadTokens.mockResolvedValue({ ...authorization(), expiresAt: new Date(0) });
      const response = new Response("invalid_grant", { status: 400 });
      if (contentType === null) response.headers.delete("content-type");
      else response.headers.set("content-type", contentType);
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
      const { db } = createMockDatabase();
      await expect(
        new GarminProvider(fetchFn).syncWebhookEvent(db, event("deregistrations"), {
          userId: "owner",
        }),
      ).rejects.toThrow("Token refresh failed (400)");
      expect(mocks.deleteProviderAuthorization).not.toHaveBeenCalled();
    },
  );
});
