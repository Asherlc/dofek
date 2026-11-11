import { providerConnection, userProfile } from "dofek/db/schema/reference";
import { ensureProvider, loadTokens, saveTokens } from "dofek/db/tokens";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../../src/db/test-helpers.ts";
import { createIntegrationMswFixture } from "../../../../../src/test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../../../../src/test/msw.ts";
import { SyncRepository } from "../../repositories/sync-repository.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const EXISTING_TOKENS = {
  accessToken: "existing-access-token",
  refreshToken: "existing-refresh-token",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  scopes: "user",
};
const GARMIN_EXISTING_TOKENS = {
  ...EXISTING_TOKENS,
  expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  providerAccountId: "existing-garmin-account",
  authorizationId: "30000000-0000-4000-8000-000000000008",
  scopes: "HEALTH_EXPORT ACTIVITY_EXPORT",
};

const mswServer = createIntegrationMswFixture();

describe("data provider OAuth reconnect", () => {
  let appServer: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let createAuthRouter: typeof import("./index.ts").createAuthRouter;
  let getOAuthStateStoreRef: typeof import("./shared.ts").getOAuthStateStoreRef;
  let testCtx: TestContext;
  let closeProviderOperationFencePool: typeof import("dofek/db/provider-operation-fence").closeProviderOperationFencePool;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.RWGPS_CLIENT_ID = "test-rwgps-client";
    process.env.RWGPS_CLIENT_SECRET = "test-rwgps-secret";
    process.env.WAHOO_CLIENT_ID = "test-wahoo-client";
    process.env.WAHOO_CLIENT_SECRET = "test-wahoo-secret";
    process.env.GARMIN_CLIENT_ID = "test-garmin-client";
    process.env.GARMIN_CLIENT_SECRET = "test-garmin-secret";
    process.env.GARMIN_WEBHOOK_SECRET = "test-garmin-webhook-secret-at-least-32-characters";

    mswServer.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    vi.resetModules();
    ({ createAuthRouter } = await import("./index.ts"));
    ({ getOAuthStateStoreRef } = await import("./shared.ts"));
    ({ closeProviderOperationFencePool } = await import("dofek/db/provider-operation-fence"));
    testCtx = await setupTestDatabase();
    process.env.DATABASE_URL = testCtx.connectionString;
    const app = express();
    app.use(createAuthRouter(testCtx.db));
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, () => {
        const address = appServer.address();
        const port = typeof address === "object" && address ? address.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    mswServer.resetHandlers();
  });

  afterEach(async () => {
    const { deleteTokens } = await import("dofek/db/tokens");
    await deleteTokens(testCtx.db, "ride-with-gps", TEST_USER_ID);
    await deleteTokens(testCtx.db, "wahoo", TEST_USER_ID);
    await deleteTokens(testCtx.db, "garmin", TEST_USER_ID);
    await deleteTokens(testCtx.db, "garmin", "30000000-0000-4000-8000-000000000006");
  });

  afterAll(async () => {
    mswServer.deactivate();
    if (appServer) {
      appServer.closeAllConnections();
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
    await closeProviderOperationFencePool?.();
    await testCtx?.cleanup();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    delete process.env.RWGPS_CLIENT_ID;
    delete process.env.RWGPS_CLIENT_SECRET;
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
    delete process.env.GARMIN_CLIENT_ID;
    delete process.env.GARMIN_CLIENT_SECRET;
    delete process.env.GARMIN_WEBHOOK_SECRET;
  });

  async function seedConnection(providerId: string, providerName: string): Promise<void> {
    await ensureProvider(testCtx.db, providerId, providerName, undefined, TEST_USER_ID);
    await saveTokens(testCtx.db, providerId, EXISTING_TOKENS, TEST_USER_ID);
  }

  async function callback(providerId: string): Promise<Response> {
    const state = `${providerId}-${crypto.randomUUID()}`;
    await getOAuthStateStoreRef().save(state, {
      providerId,
      intent: "data",
      userId: TEST_USER_ID,
      codeVerifier: "integration-pkce-verifier",
    });
    return fetch(`${baseUrl}/callback?code=new-code&state=${state}`);
  }

  async function seedGarminConnection(): Promise<void> {
    await ensureProvider(testCtx.db, "garmin", "Garmin", undefined, TEST_USER_ID);
    await saveTokens(testCtx.db, "garmin", GARMIN_EXISTING_TOKENS, TEST_USER_ID);
  }

  function mockGarminReplacement(accountId = GARMIN_EXISTING_TOKENS.providerAccountId) {
    let deregistrations = 0;
    const grantTypes: Array<string | null> = [];
    mswServer.use(
      http.post("https://diauth.garmin.com/di-oauth2-service/oauth/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        grantTypes.push(body.get("grant_type"));
        return HttpResponse.json({
          access_token: "replacement-garmin-access",
          refresh_token: "replacement-garmin-refresh",
          expires_in: 86400,
        });
      }),
      http.get("https://apis.garmin.com/partner-gateway/rest/user/id", () =>
        HttpResponse.json({ userId: accountId }),
      ),
      http.get("https://apis.garmin.com/partner-gateway/rest/user/permissions", () =>
        HttpResponse.json({ permissions: ["HEALTH_EXPORT"] }),
      ),
      http.delete("https://apis.garmin.com/partner-gateway/rest/user/registration", () => {
        deregistrations++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return { deregistrations: () => deregistrations, grantTypes };
  }

  it("reconnects the same Garmin account by replacing credentials and preserving its registration", async () => {
    await seedGarminConnection();
    const requests = mockGarminReplacement();

    const response = await callback("garmin");

    expect(response.status).toBe(200);
    const stored = await loadTokens(testCtx.db, "garmin", TEST_USER_ID);
    expect(stored).toMatchObject({
      accessToken: "replacement-garmin-access",
      refreshToken: "replacement-garmin-refresh",
      providerAccountId: GARMIN_EXISTING_TOKENS.providerAccountId,
      scopes: "HEALTH_EXPORT",
    });
    expect(stored?.authorizationId).toBeDefined();
    expect(stored?.authorizationId).not.toBe(GARMIN_EXISTING_TOKENS.authorizationId);
    expect(requests.deregistrations()).toBe(0);
    expect(requests.grantTypes).toEqual(["authorization_code"]);
  });

  it.each(["reconnect", "first connection"])(
    "preserves Garmin registration when %s persistence fails",
    async (connection) => {
      if (connection === "reconnect") await seedGarminConnection();
      const requests = mockGarminReplacement();
      await testCtx.db.execute(sql`
      CREATE FUNCTION fitness.reject_garmin_replacement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provider_id = 'garmin' THEN
          RAISE EXCEPTION 'test replacement persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_garmin_replacement BEFORE INSERT OR UPDATE ON fitness.oauth_token
      FOR EACH ROW EXECUTE FUNCTION fitness.reject_garmin_replacement();
    `);
      try {
        const response = await callback("garmin");

        expect(response.status).toBe(connection === "reconnect" ? 400 : 500);
        await expect(loadTokens(testCtx.db, "garmin", TEST_USER_ID)).resolves.toEqual(
          connection === "reconnect" ? GARMIN_EXISTING_TOKENS : null,
        );
        expect(requests.deregistrations()).toBe(0);
        expect(requests.grantTypes).toEqual(["authorization_code"]);
      } finally {
        await testCtx.db.execute(sql`
        DROP TRIGGER reject_garmin_replacement ON fitness.oauth_token;
        DROP FUNCTION fitness.reject_garmin_replacement();
      `);
      }
    },
  );

  it("requires disconnecting Garmin before connecting a different Garmin account", async () => {
    await seedGarminConnection();
    const requests = mockGarminReplacement("different-garmin-account");

    const response = await callback("garmin");

    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("Disconnect Garmin Connect first");
    await expect(loadTokens(testCtx.db, "garmin", TEST_USER_ID)).resolves.toEqual(
      GARMIN_EXISTING_TOKENS,
    );
    expect(requests.deregistrations()).toBe(0);
    expect(requests.grantTypes).toEqual(["authorization_code"]);
  });

  it.each(["id", "permissions"])(
    "preserves Garmin's existing registration when the replacement %s lookup fails",
    async (resource) => {
      await seedGarminConnection();
      const requests = mockGarminReplacement();
      mswServer.use(
        http.get(`https://apis.garmin.com/partner-gateway/rest/user/${resource}`, () =>
          HttpResponse.text("temporary outage", { status: 503 }),
        ),
      );

      const response = await callback("garmin");

      expect(response.status).toBe(400);
      await expect(loadTokens(testCtx.db, "garmin", TEST_USER_ID)).resolves.toEqual(
        GARMIN_EXISTING_TOKENS,
      );
      expect(requests.deregistrations()).toBe(0);
      expect(requests.grantTypes).toEqual(["authorization_code"]);
    },
  );

  it.each(["id", "permissions"])(
    "does not deregister another Dofek owner's Garmin registration after first-connect %s failure",
    async (resource) => {
      const ownerId = "30000000-0000-4000-8000-000000000006";
      await testCtx.db
        .insert(userProfile)
        .values({ id: ownerId, name: "Existing Garmin owner" })
        .onConflictDoNothing();
      await ensureProvider(testCtx.db, "garmin", "Garmin", undefined, ownerId);
      const existing = { ...GARMIN_EXISTING_TOKENS, providerAccountId: "already-owned-garmin" };
      await saveTokens(testCtx.db, "garmin", existing, ownerId);
      const requests = mockGarminReplacement(existing.providerAccountId);
      mswServer.use(
        http.get(`https://apis.garmin.com/partner-gateway/rest/user/${resource}`, () =>
          HttpResponse.text("temporary outage", { status: 503 }),
        ),
      );

      const response = await callback("garmin");

      expect(response.status).toBe(500);
      expect(requests.deregistrations()).toBe(0);
      expect(requests.grantTypes).toEqual(["authorization_code"]);
      await expect(loadTokens(testCtx.db, "garmin", ownerId)).resolves.toEqual(existing);
      await expect(loadTokens(testCtx.db, "garmin", TEST_USER_ID)).resolves.toBeNull();
    },
  );

  it.each(["id", "permissions"])(
    "preserves an unowned first-connect Garmin registration after %s failure for retry",
    async (resource) => {
      const requests = mockGarminReplacement("unowned-first-connection");
      mswServer.use(
        http.get(`https://apis.garmin.com/partner-gateway/rest/user/${resource}`, () =>
          HttpResponse.text("temporary outage", { status: 503 }),
        ),
      );

      const response = await callback("garmin");

      expect(response.status).toBe(500);
      expect(requests.deregistrations()).toBe(0);
      expect(requests.grantTypes).toEqual(["authorization_code"]);
      await expect(loadTokens(testCtx.db, "garmin", TEST_USER_ID)).resolves.toBeNull();
    },
  );

  it("rejects Garmin ownership conflict without deregistering the existing owner's remote authorization", async () => {
    const ownerId = "30000000-0000-4000-8000-000000000006";
    await testCtx.db
      .insert(userProfile)
      .values({ id: ownerId, name: "Existing Garmin owner" })
      .onConflictDoNothing();
    await ensureProvider(testCtx.db, "garmin", "Garmin", undefined, ownerId);
    const existing = {
      ...EXISTING_TOKENS,
      providerAccountId: "already-owned-garmin",
      authorizationId: "30000000-0000-4000-8000-000000000007",
      scopes: "HEALTH_EXPORT",
    };
    await saveTokens(testCtx.db, "garmin", existing, ownerId);
    let deregistrations = 0;
    mswServer.use(
      http.post("https://diauth.garmin.com/di-oauth2-service/oauth/token", () =>
        HttpResponse.json({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 86400,
        }),
      ),
      http.get("https://apis.garmin.com/partner-gateway/rest/user/id", () =>
        HttpResponse.json({ userId: "already-owned-garmin" }),
      ),
      http.get("https://apis.garmin.com/partner-gateway/rest/user/permissions", () =>
        HttpResponse.json({ permissions: ["HEALTH_EXPORT"] }),
      ),
      http.delete("https://apis.garmin.com/partner-gateway/rest/user/registration", () => {
        deregistrations++;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const response = await callback("garmin");
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("another Dofek account");
    expect(deregistrations).toBe(0);
    await expect(loadTokens(testCtx.db, "garmin", ownerId)).resolves.toEqual(existing);
    await expect(loadTokens(testCtx.db, "garmin", TEST_USER_ID)).resolves.toBeNull();
  });

  it("preserves working RideWithGPS tokens when the replacement exchange fails", async () => {
    await seedConnection("ride-with-gps", "RideWithGPS");
    let revocationRequests = 0;
    mswServer.use(
      http.post("https://ridewithgps.com/oauth/token.json", () =>
        HttpResponse.text("temporary outage", { status: 503 }),
      ),
      http.post("https://ridewithgps.com/oauth/revoke", () => {
        revocationRequests++;
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const response = await callback("ride-with-gps");

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("existing connection is still active");
    await expect(loadTokens(testCtx.db, "ride-with-gps", TEST_USER_ID)).resolves.toEqual(
      EXISTING_TOKENS,
    );
    expect(revocationRequests).toBe(0);
  });

  it("removes the Wahoo connection after token-limit deauthorization", async () => {
    await seedConnection("wahoo", "Wahoo");
    mswServer.use(
      http.delete("https://api.wahooligan.com/v1/permissions", () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("https://api.wahooligan.com/oauth/token", () =>
        HttpResponse.json(
          { error: "Too many unrevoked access tokens exist for this app and user." },
          { status: 400 },
        ),
      ),
    );

    const response = await callback("wahoo");

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("previous Wahoo authorization was removed");
    expect(body).toContain("/auth/provider/wahoo");
    expect(body).not.toContain("Authorized Apps");
    await expect(loadTokens(testCtx.db, "wahoo", TEST_USER_ID)).resolves.toBeNull();
    const connections = await testCtx.db
      .select()
      .from(providerConnection)
      .where(
        and(
          eq(providerConnection.userId, TEST_USER_ID),
          eq(providerConnection.providerId, "wahoo"),
        ),
      );
    expect(connections).toEqual([]);
    const connectedProviderIds = await new SyncRepository(
      testCtx.db,
      TEST_USER_ID,
    ).getConnectedProviderIds();
    expect(connectedProviderIds).not.toContainEqual(
      expect.objectContaining({ providerId: "wahoo" }),
    );
  });

  it("preserves stored Wahoo tokens when provider revocation fails", async () => {
    await seedConnection("wahoo", "Wahoo");
    let tokenRequests = 0;
    mswServer.use(
      http.delete("https://api.wahooligan.com/v1/permissions", () =>
        HttpResponse.text("temporary outage", { status: 503 }),
      ),
      http.post("https://api.wahooligan.com/oauth/token", () => {
        tokenRequests++;
        return HttpResponse.json(
          { error: "Too many unrevoked access tokens exist for this app and user." },
          { status: 400 },
        );
      }),
    );

    const response = await callback("wahoo");

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("existing connection is still active");
    await expect(loadTokens(testCtx.db, "wahoo", TEST_USER_ID)).resolves.toEqual(EXISTING_TOKENS);
    expect(tokenRequests).toBe(1);
  });

  it("replaces Wahoo tokens without deauthorization when exchange succeeds", async () => {
    await seedConnection("wahoo", "Wahoo");
    let revocationRequests = 0;
    mswServer.use(
      http.delete("https://api.wahooligan.com/v1/permissions", () => {
        revocationRequests++;
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("https://api.wahooligan.com/oauth/token", () =>
        HttpResponse.json({
          access_token: "replacement-access-token",
          refresh_token: "replacement-refresh-token",
          expires_in: 3600,
          scope: "user_read",
        }),
      ),
      http.get("https://api.wahooligan.com/v1/user", () =>
        HttpResponse.json({
          id: 123,
          first_name: "Test",
          last_name: "Athlete",
        }),
      ),
    );

    const response = await callback("wahoo");

    expect(response.status).toBe(200);
    expect(revocationRequests).toBe(0);
    const stored = await loadTokens(testCtx.db, "wahoo", TEST_USER_ID);
    expect(stored).toMatchObject({
      accessToken: "replacement-access-token",
      refreshToken: "replacement-refresh-token",
      scopes: "user_read",
    });
  });
});
