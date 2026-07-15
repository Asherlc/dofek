import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { isEncryptedCredentialValue } from "dofek/security/credential-encryption";
import { sql } from "drizzle-orm";
import type express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const insertedUserRowSchema = z.object({ id: z.string() });
const storedClientSecretRowSchema = z.object({ client_secret: z.string() });
const oauthMetadataSchema = z.object({
  authorization_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  issuer: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string(),
  token_endpoint: z.string(),
});
const protectedResourceMetadataSchema = z.object({
  authorization_servers: z.array(z.string()),
  resource: z.string(),
  scopes_supported: z.array(z.string()),
});
const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
  token_type: z.literal("bearer"),
});
const registeredClientSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  client_secret_expires_at: z.number(),
  redirect_uris: z.array(z.string()),
});

const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const resource = "https://app.example.test/api/mcp";

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

describe("MCP OAuth", () => {
  let context: TestContext;
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let sessionCookie: string;
  let registeredClient: z.infer<typeof registeredClientSchema>;

  beforeAll(async () => {
    context = await setupTestDatabase();
    const app = createApp(context.db, makeMockSensorStore());
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://localhost:${getPort(server)}`;
    closeServer = () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }, 120_000);

  afterAll(async () => {
    await closeServer?.();
    await context?.cleanup();
  });

  beforeEach(async () => {
    await context.db.execute(sql`DELETE FROM fitness.mcp_oauth_refresh_token`);
    await context.db.execute(sql`DELETE FROM fitness.mcp_oauth_authorization_code`);
    await context.db.execute(sql`DELETE FROM fitness.mcp_access_token`);
    await context.db.execute(sql`DELETE FROM fitness.mcp_oauth_client`);
    await context.db.execute(sql`DELETE FROM fitness.session`);
    await context.db.execute(
      sql`DELETE FROM fitness.user_profile WHERE email = 'mcp-oauth@test.com'`,
    );
    const rows = await executeWithSchema(
      context.db,
      insertedUserRowSchema,
      sql`INSERT INTO fitness.user_profile (name, email)
          VALUES ('MCP OAuth User', 'mcp-oauth@test.com') RETURNING id`,
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error("Failed to create OAuth test user");
    const session = await createSession(context.db, userId);
    sessionCookie = `session=${session.sessionId}`;
    registeredClient = await registerClient();
  });

  it("publishes OAuth discovery metadata with dynamic registration", async () => {
    const authorizationMetadata = oauthMetadataSchema.parse(
      await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json(),
    );
    expect(authorizationMetadata).toMatchObject({
      authorization_endpoint: "https://app.example.test/authorize",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      issuer: "https://app.example.test/",
      revocation_endpoint: "https://app.example.test/revoke",
      token_endpoint: "https://app.example.test/token",
    });
    expect(authorizationMetadata.registration_endpoint).toBe("https://app.example.test/register");

    const resourceMetadata = protectedResourceMetadataSchema.parse(
      await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/api/mcp`)).json(),
    );
    expect(resourceMetadata).toMatchObject({
      authorization_servers: ["https://app.example.test/"],
      resource,
    });
    expect(resourceMetadata.scopes_supported).toContain("health:read");
  });

  it("issues distinct credentials for each client registration", async () => {
    const anotherClient = await registerClient();

    expect(anotherClient.client_id).not.toBe(registeredClient.client_id);
    expect(anotherClient.client_secret).not.toBe(registeredClient.client_secret);
    expect(anotherClient.redirect_uris).toEqual([redirectUri]);

    const storedRows = await executeWithSchema(
      context.db,
      storedClientSecretRowSchema,
      sql`SELECT client_secret
          FROM fitness.mcp_oauth_client
          WHERE client_id = ${registeredClient.client_id}`,
    );
    const storedSecret = storedRows[0]?.client_secret;
    expect(storedSecret).not.toBe(registeredClient.client_secret);
    expect(storedSecret ? isEncryptedCredentialValue(storedSecret) : false).toBe(true);
  });

  it("rejects registrations with non-Claude callback URLs", async () => {
    const response = await rawRegisterClient("https://attacker.example/callback");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_client_metadata" });
  });

  it("requires login before displaying consent", async () => {
    const authorizationUrl = new URL(`${baseUrl}/authorize`);
    authorizationUrl.search = authorizationParameters(
      randomBytes(32).toString("base64url"),
    ).toString();

    const response = await fetch(authorizationUrl, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/login?returnTo=");
  });

  it("completes authorization, refresh rotation, MCP access, and revocation", async () => {
    const codeVerifier = randomBytes(32).toString("base64url");
    const parameters = authorizationParameters(codeVerifier);

    const consentResponse = await fetch(`${baseUrl}/authorize?${parameters}`, {
      headers: { Cookie: sessionCookie, "X-Forwarded-For": "203.0.113.10" },
    });
    expect(consentResponse.status).toBe(200);
    const consentBody = await consentResponse.text();
    expect(consentBody).toContain("Allow Claude to access Dofek?");
    expect(consentBody).toContain("View your daily health summaries");

    parameters.set("approval", "approve");
    const approvalResponse = await fetch(`${baseUrl}/authorize`, {
      body: parameters,
      headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    expect(approvalResponse.status).toBe(302);
    const callbackUrl = new URL(approvalResponse.headers.get("location") ?? "");
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
    expect(callbackUrl.searchParams.get("state")).toBe("state-value");
    const authorizationCode = callbackUrl.searchParams.get("code");
    if (!authorizationCode) throw new Error("Missing authorization code");

    const tokenResponse = await exchangeAuthorizationCode(authorizationCode, codeVerifier);
    expect(tokenResponse.expires_in).toBe(3600);
    expect(tokenResponse.scope).toBe("health:read activity:read");

    expect(await requestMcp(tokenResponse.access_token)).toBe(200);

    const refreshedTokens = await refreshTokens(tokenResponse.refresh_token);
    expect(refreshedTokens.access_token).not.toBe(tokenResponse.access_token);
    expect(refreshedTokens.refresh_token).not.toBe(tokenResponse.refresh_token);

    expect((await rawRefreshResponse(tokenResponse.refresh_token)).status).toBe(400);
    expect(await requestMcp(tokenResponse.access_token)).toBe(401);

    const revokeResponse = await fetch(`${baseUrl}/revoke`, {
      body: new URLSearchParams({
        client_id: registeredClient.client_id,
        client_secret: registeredClient.client_secret,
        token: refreshedTokens.refresh_token,
        token_type_hint: "refresh_token",
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect(revokeResponse.status).toBe(200);
    expect((await rawRefreshResponse(refreshedTokens.refresh_token)).status).toBe(400);

    const nextTokens = await completeAuthorization(codeVerifier);
    const revokeAccessResponse = await revokeToken(nextTokens.access_token, "access_token");
    expect(revokeAccessResponse.status).toBe(200);
    expect((await rawRefreshResponse(nextTokens.refresh_token)).status).toBe(400);
  });

  function authorizationParameters(codeVerifier: string): URLSearchParams {
    return new URLSearchParams({
      client_id: registeredClient.client_id,
      code_challenge: codeChallenge(codeVerifier),
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      resource,
      response_type: "code",
      scope: "health:read activity:read",
      state: "state-value",
    });
  }

  async function exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    const response = await fetch(`${baseUrl}/token`, {
      body: new URLSearchParams({
        client_id: registeredClient.client_id,
        client_secret: registeredClient.client_secret,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        resource,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    return tokenResponseSchema.parse(await response.json());
  }

  async function rawRefreshResponse(refreshToken: string): Promise<Response> {
    return fetch(`${baseUrl}/token`, {
      body: new URLSearchParams({
        client_id: registeredClient.client_id,
        client_secret: registeredClient.client_secret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        resource,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  }

  async function refreshTokens(refreshToken: string): Promise<z.infer<typeof tokenResponseSchema>> {
    return tokenResponseSchema.parse(await (await rawRefreshResponse(refreshToken)).json());
  }

  async function requestMcp(accessToken: string): Promise<number> {
    const response = await fetch(`${baseUrl}/api/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "OAuth integration test", version: "1" },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    return response.status;
  }

  async function completeAuthorization(
    codeVerifier: string,
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    const parameters = authorizationParameters(codeVerifier);
    parameters.set("approval", "approve");
    const response = await fetch(`${baseUrl}/authorize`, {
      body: parameters,
      headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    const callbackUrl = new URL(response.headers.get("location") ?? "");
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    return exchangeAuthorizationCode(code, codeVerifier);
  }

  async function revokeToken(token: string, tokenTypeHint: string): Promise<Response> {
    return fetch(`${baseUrl}/revoke`, {
      body: new URLSearchParams({
        client_id: registeredClient.client_id,
        client_secret: registeredClient.client_secret,
        token,
        token_type_hint: tokenTypeHint,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  }

  async function registerClient(): Promise<z.infer<typeof registeredClientSchema>> {
    const response = await rawRegisterClient(redirectUri);
    expect(response.status).toBe(201);
    return registeredClientSchema.parse(await response.json());
  }

  async function rawRegisterClient(clientRedirectUri: string): Promise<Response> {
    return fetch(`${baseUrl}/register`, {
      body: JSON.stringify({
        client_name: "Claude",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [clientRedirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      }),
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
      method: "POST",
    });
  }
});
