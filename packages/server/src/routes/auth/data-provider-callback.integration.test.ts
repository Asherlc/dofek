import { ensureProvider, loadTokens, saveTokens } from "dofek/db/tokens";
import express from "express";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../../src/db/test-helpers.ts";
import { failOnUnhandledExternalRequest } from "../../../../../src/test/msw.ts";
import { createAuthRouter } from "./index.ts";
import { getOAuthStateStoreRef } from "./shared.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const EXISTING_TOKENS = {
  accessToken: "existing-access-token",
  refreshToken: "existing-refresh-token",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  scopes: "user",
};

const mswServer = setupServer();

describe("data provider OAuth reconnect", () => {
  let appServer: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;

  beforeAll(async () => {
    process.env.RWGPS_CLIENT_ID = "test-rwgps-client";
    process.env.RWGPS_CLIENT_SECRET = "test-rwgps-secret";
    process.env.WAHOO_CLIENT_ID = "test-wahoo-client";
    process.env.WAHOO_CLIENT_SECRET = "test-wahoo-secret";

    testCtx = await setupTestDatabase();
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
    mswServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  beforeEach(async () => {
    mswServer.resetHandlers();
  });

  afterEach(async () => {
    const { deleteTokens } = await import("dofek/db/tokens");
    await deleteTokens(testCtx.db, "ride-with-gps", TEST_USER_ID);
    await deleteTokens(testCtx.db, "wahoo", TEST_USER_ID);
  });

  afterAll(async () => {
    mswServer.close();
    if (appServer) {
      appServer.closeAllConnections();
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
    await testCtx?.cleanup();
    delete process.env.RWGPS_CLIENT_ID;
    delete process.env.RWGPS_CLIENT_SECRET;
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
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
    });
    return fetch(`${baseUrl}/callback?code=new-code&state=${state}`);
  }

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

  it("clears locally stored Wahoo tokens after confirmed revocation if exchange fails", async () => {
    await seedConnection("wahoo", "Wahoo");
    mswServer.use(
      http.delete("https://api.wahooligan.com/v1/permissions", () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("https://api.wahooligan.com/oauth/token", () =>
        HttpResponse.text("temporary outage", { status: 503 }),
      ),
    );

    const response = await callback("wahoo");

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("previous Wahoo authorization was removed");
    expect(body).toContain("connect Wahoo again");
    await expect(loadTokens(testCtx.db, "wahoo", TEST_USER_ID)).resolves.toBeNull();
  });

  it("replaces Wahoo tokens after revoking the provider-limited authorization", async () => {
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
    expect(revocationRequests).toBe(1);
    const stored = await loadTokens(testCtx.db, "wahoo", TEST_USER_ID);
    expect(stored).toMatchObject({
      accessToken: "replacement-access-token",
      refreshToken: "replacement-refresh-token",
      scopes: "user_read",
    });
  });
});
