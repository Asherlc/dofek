import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";
import { createSession } from "../../auth/session.ts";
import { createApp } from "../../index.ts";

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

// MSW handlers for WHOOP Cognito auth and bootstrap endpoints
function cognitoSuccessHandler(accessToken: string, refreshToken: string) {
  return http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
    return HttpResponse.json({
      AuthenticationResult: {
        AccessToken: accessToken,
        RefreshToken: refreshToken,
      },
    });
  });
}

function cognitoMfaHandler(session: string, challengeName = "SMS_MFA") {
  return http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
    return HttpResponse.json({
      ChallengeName: challengeName,
      Session: session,
    });
  });
}

function bootstrapHandler(userId: number) {
  return http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
    return HttpResponse.json({ id: userId });
  });
}

const mswServer = setupServer();

describe("whoopAuth router", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, DEFAULT_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    const app = createApp(testCtx.db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    mswServer.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  afterEach(() => {
    mswServer.resetHandlers();
  });

  /** POST a tRPC mutation */
  async function mutate(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    const first: {
      result?: { data?: unknown };
      error?: { message: string; json?: { message: string } };
    } = data[0];
    return { status: res.status, result: first };
  }

  describe("signIn", () => {
    it("returns token on successful sign-in (no MFA)", async () => {
      mswServer.use(
        cognitoSuccessHandler("whoop-access-token", "whoop-refresh-token"),
        bootstrapHandler(12345),
      );

      const { result } = await mutate("whoopAuth.signIn", {
        username: "user@test.com",
        password: "password123",
      });

      expect(result?.result?.data).toEqual({
        status: "success",
        token: {
          accessToken: "whoop-access-token",
          refreshToken: "whoop-refresh-token",
          userId: 12345,
        },
      });
    });

    it("returns verification_required when MFA is needed", async () => {
      mswServer.use(cognitoMfaHandler("cognito-session-abc", "SMS_MFA"));

      const { result } = await mutate("whoopAuth.signIn", {
        username: "user@test.com",
        password: "password123",
      });

      // @ts-expect-error result data is unknown but we know the shape from the API
      const data: {
        status: string;
        challengeId: string;
        method: string;
      } = result?.result?.data;
      expect(data.status).toBe("verification_required");
      expect(data.challengeId).toMatch(/^whoop-/);
      expect(data.method).toBe("SMS_MFA");
    });
  });

  describe("verifyCode", () => {
    it("returns token after successful MFA verification", async () => {
      // First, sign in to create a pending challenge
      mswServer.use(cognitoMfaHandler("cognito-session-xyz", "SMS_MFA"));

      const signInResult = await mutate("whoopAuth.signIn", {
        username: "user@test.com",
        password: "password123",
      });
      // @ts-expect-error result data is unknown but we know the shape from the API
      const signInData: {
        challengeId: string;
      } = signInResult.result?.result?.data;

      // Now set up handlers for the verify code flow
      mswServer.resetHandlers();
      mswServer.use(
        cognitoSuccessHandler("verified-access-token", "verified-refresh-token"),
        bootstrapHandler(99999),
      );

      const { result } = await mutate("whoopAuth.verifyCode", {
        challengeId: signInData.challengeId,
        code: "123456",
      });

      // @ts-expect-error result data is unknown but we know the shape from the API
      const data: {
        status: string;
        token: { accessToken: string; refreshToken: string; userId: number };
      } = result?.result?.data;
      expect(data.status).toBe("success");
      expect(data.token.accessToken).toBe("verified-access-token");
      expect(data.token.userId).toBe(99999);
    });

    it("returns error for expired/missing challenge", async () => {
      const { result } = await mutate("whoopAuth.verifyCode", {
        challengeId: "nonexistent-challenge",
        code: "123456",
      });

      // Should get an error response
      expect(result?.error).toBeDefined();
    });
  });

  describe("saveTokens", () => {
    it("saves tokens to the database", async () => {
      const { status, result } = await mutate("whoopAuth.saveTokens", {
        accessToken: "saved-access-token",
        refreshToken: "saved-refresh-token",
        userId: 42,
      });

      expect(status).toBe(200);
      // @ts-expect-error result data is unknown but we know the shape from the API
      const data: { success: boolean } = result?.result?.data;
      expect(data.success).toBe(true);

      // Verify provider was created
      const providerRows = await testCtx.db.execute<{ id: string }>(
        sql`SELECT id FROM fitness.provider WHERE id = 'whoop'`,
      );
      expect(providerRows.length).toBe(1);

      // Verify token was saved
      const tokenRows = await testCtx.db.execute<{ access_token: string; scopes: string }>(
        sql`SELECT access_token, scopes FROM fitness.oauth_token WHERE provider_id = 'whoop'`,
      );
      expect(tokenRows.length).toBe(1);
      expect(tokenRows[0]?.access_token).toBe("saved-access-token");
      expect(tokenRows[0]?.scopes).toBe("userId:42");
    });
  });
});
