import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const userId = "10000000-0000-4000-8000-000000002248";

describe("tracking MCP scope migration", () => {
  let context: TestContext;
  let client: Client;

  beforeAll(async () => {
    context = await setupTestDatabase();
    client = new Client({ connectionString: context.connectionString });
    await client.connect();
    await client.query(
      "INSERT INTO fitness.user_profile (id, name) VALUES ($1, 'MCP Scope User')",
      [userId],
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await context?.cleanup();
  });

  it("preserves existing tokens, grant metadata, and supported scopes", async () => {
    await client.query(
      `INSERT INTO fitness.mcp_access_token (user_id, name, token_hash, scopes)
       VALUES ($1, 'Existing token', 'tracking-scope-fixture', ARRAY['health:read', 'health:write', 'nutrition:write'])`,
      [userId],
    );
    const token = {
      scope: "health:read health:write nutrition:write",
      clientId: "existing-client",
      accountId: userId,
    };
    const grant = {
      resources: {
        "https://dofek.example/mcp": "health:read health:write nutrition:write",
        "https://other.example/mcp": "health:read",
      },
      openid: { scope: "openid health:write profile", claims: ["sub"] },
      clientId: "existing-client",
    };
    await client.query(
      `INSERT INTO fitness.mcp_oidc_adapter (model, id, payload, user_id)
       VALUES ('AccessToken', 'existing-token', $1::jsonb, $3), ('Grant', 'existing-grant', $2::jsonb, $3)`,
      [JSON.stringify(token), JSON.stringify(grant), userId],
    );
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0138_remove_tracking_mcp_scope.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      await client.query(statement);

    const tokens = await client.query(
      "SELECT name, scopes FROM fitness.mcp_access_token WHERE token_hash = 'tracking-scope-fixture'",
    );
    expect(tokens.rows).toEqual([
      { name: "Existing token", scopes: ["health:read", "nutrition:write"] },
    ]);
    const artifacts = await client.query(
      "SELECT id, payload FROM fitness.mcp_oidc_adapter WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    expect(artifacts.rows).toEqual([
      {
        id: "existing-grant",
        payload: {
          ...grant,
          resources: {
            "https://dofek.example/mcp": "health:read nutrition:write",
            "https://other.example/mcp": "health:read",
          },
          openid: { scope: "openid profile", claims: ["sub"] },
        },
      },
      { id: "existing-token", payload: { ...token, scope: "health:read nutrition:write" } },
    ]);
  });
});
