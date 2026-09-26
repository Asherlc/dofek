import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createApp } from "../index.ts";
import { makeMockSensorStore } from "../routers/test-helpers.ts";

/**
 * oidc-provider authorization server integration tests.
 *
 * These require a running Postgres (via `pnpm test:integration` / Docker). They
 * exercise the oidc-provider-backed Dofek MCP authorization server: discovery
 * metadata advertising RFC 9207 `iss` and CIMD support, and RFC 7591 dynamic
 * client registration.
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

const registrationSchema = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number().optional(),
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.string().optional(),
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
      await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json(),
    );
    expect(metadata.issuer).toBe("https://app.example.test/");
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.scopes_supported).toContain("health:read");
    expect(metadata.scopes_supported).toContain("offline_access");
  });

  it("registers a client via RFC 7591 dynamic client registration", async () => {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP Integration Client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(201);
    const client = registrationSchema.parse(await response.json());
    expect(typeof client.client_id).toBe("string");
    expect(client.client_id.length).toBeGreaterThan(0);
    expect(client.redirect_uris).toContain(redirectUri);
  });
});
