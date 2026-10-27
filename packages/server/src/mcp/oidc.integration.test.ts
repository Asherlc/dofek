import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createApp } from "../index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import { createMcpOidcAdapter } from "./oidc/adapter.ts";

/**
 * oidc-provider authorization server integration tests.
 *
 * These require a running Postgres (via `pnpm test:integration` / Docker). They
 * exercise the oidc-provider-backed Dofek MCP authorization server: discovery
 * metadata advertising RFC 9207 `iss` and CIMD support, and the authorization
 * flow for public clients.
 */

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  authorization_response_iss_parameter_supported: z.literal(true),
  client_id_metadata_document_supported: z.literal(true),
  scopes_supported: z.array(z.string()),
});

const redirectUri = "https://claude.ai/api/mcp/auth_callback";

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

describe("MCP oidc-provider authorization server", () => {
  let context: TestContext;
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    context = await setupTestDatabase();
    const app = createApp(context.db, makeMockSensorStore(), { mcpAuthRateLimit: false });
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
    await context.db.execute(sql`DELETE FROM fitness.mcp_oidc_adapter`);
  });

  it("publishes authorization server discovery with RFC 9207 iss and CIMD support", async () => {
    const metadata = discoverySchema.parse(
      await (
        await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
          headers: { "x-forwarded-proto": "https" },
        })
      ).json(),
    );
    expect(metadata.issuer).toBe("https://app.example.test/");
    expect(new URL(metadata.token_endpoint).protocol).toBe("https:");
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.scopes_supported).toContain("health:read");
    expect(metadata.scopes_supported).toContain("offline_access");
  });

  it("defaults authorization requests without resource to Dofek's MCP resource", async () => {
    const clientId = "default-resource-test-client";
    await createMcpOidcAdapter(context.db)("Client").upsert(clientId, {
      client_id: clientId,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const verifier = "integration-pkce-verifier";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL("/authorize", baseUrl);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "health:read",
      state: "default-resource-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(303);
    const interactions = await executeWithSchema(
      context.db,
      z.object({ payload: z.record(z.string(), z.unknown()) }),
      sql`SELECT payload FROM fitness.mcp_oidc_adapter WHERE model = 'Interaction' LIMIT 1`,
    );
    expect(interactions[0]?.payload).toMatchObject({
      params: { resource: "https://app.example.test/api/mcp" },
    });
  });

  it.each(["revocation", "refresh replay"])(
    "issues public MCP tokens without offline_access and enforces %s",
    async (scenario) => {
      const resource = "https://app.example.test/api/mcp";
      const clientId = "issued-token-client";
      const grantId = "issued-token-grant";
      const code = "integration-authorization-code";
      const verifier = "integration-pkce-verifier-with-at-least-43-characters";
      const rows = await executeWithSchema(
        context.db,
        z.object({ id: z.string() }),
        sql`INSERT INTO fitness.user_profile (name, email) VALUES ('OAuth Test', 'issued-token@test.com') RETURNING id`,
      );
      const accountId = rows[0]?.id;
      if (!accountId) throw new Error("Failed to create OAuth test user");
      const adapter = createMcpOidcAdapter(context.db);
      await adapter("Client").upsert(clientId, {
        client_id: clientId,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      await adapter("Grant").upsert(
        grantId,
        { jti: grantId, accountId, clientId, resources: { [resource]: "health:read" } },
        3600,
      );
      await adapter("AuthorizationCode").upsert(
        code,
        {
          jti: code,
          accountId,
          clientId,
          grantId,
          redirectUri,
          scope: "health:read",
          resource,
          codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
          codeChallengeMethod: "S256",
        },
        600,
      );
      try {
        const response = await fetch(`${baseUrl}/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-proto": "https",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource,
          }),
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        const { access_token, refresh_token } = z
          .object({ access_token: z.string(), refresh_token: z.string() })
          .parse(body);
        const initialize = (token: string) =>
          fetch(`${baseUrl}/api/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "oauth-regression", version: "1" },
              },
            }),
          });
        const initialized = await initialize(access_token);
        expect(initialized.status).toBe(200);
        expect(await initialized.text()).toContain("serverInfo");
        if (scenario === "revocation") {
          const revoked = await fetch(`${baseUrl}/revoke`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-forwarded-proto": "https",
            },
            body: new URLSearchParams({
              client_id: clientId,
              token: access_token,
              token_type_hint: "access_token",
            }),
          });
          expect(revoked.status).toBe(200);
          expect((await initialize(access_token)).status).toBe(401);
          return;
        }
        const refresh = () =>
          fetch(`${baseUrl}/token`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-forwarded-proto": "https",
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token,
              resource,
            }),
          });
        const refreshed = await refresh();
        const refreshedBody = await refreshed.json();
        expect(refreshed.status, JSON.stringify(refreshedBody)).toBe(200);
        const rotated = z
          .object({ access_token: z.string(), refresh_token: z.string() })
          .parse(refreshedBody);
        expect(rotated.refresh_token).not.toBe(refresh_token);
        expect((await initialize(rotated.access_token)).status).toBe(200);
        const replayed = await refresh();
        expect(replayed.status).toBe(400);
        expect(await replayed.json()).toMatchObject({ error: "invalid_grant" });
        expect((await initialize(rotated.access_token)).status).toBe(401);
      } finally {
        await context.db.execute(
          sql`DELETE FROM fitness.user_profile WHERE id = ${accountId}::uuid`,
        );
      }
    },
  );
});
