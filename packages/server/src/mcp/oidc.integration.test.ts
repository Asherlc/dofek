import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { backfillMcpOauthClients } from "../../../../src/db/backfill-mcp-oauth-clients.ts";
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

  it("imports existing registered OAuth clients idempotently", async () => {
    const clientId = "legacy-client-migration-test";
    await context.db.execute(
      sql`INSERT INTO fitness.mcp_oauth_client (
            client_id, client_secret, client_metadata, client_id_issued_at,
            client_secret_expires_at
          ) VALUES (
            ${clientId}, NULL,
            ${JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })}::jsonb,
            1, NULL
          )`,
    );

    try {
      expect(await backfillMcpOauthClients(context.db)).toBe(1);
      expect(await backfillMcpOauthClients(context.db)).toBe(0);
      await expect(
        createMcpOidcAdapter(context.db)("Client").find(clientId),
      ).resolves.toMatchObject({
        client_id: clientId,
        client_id_issued_at: 1,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      });
    } finally {
      await context.db.execute(
        sql`DELETE FROM fitness.mcp_oauth_client WHERE client_id = ${clientId}`,
      );
      await context.db.execute(
        sql`DELETE FROM fitness.mcp_oidc_adapter WHERE model = 'Client' AND id = ${clientId}`,
      );
    }
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
});
