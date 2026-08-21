import { randomBytes } from "node:crypto";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";
import { isAllowedMcpOAuthRedirectUri, McpOAuthClientsStore } from "./oauth-client-store.ts";

function makeMockDb() {
  return {
    execute: vi.fn().mockResolvedValue([]),
  };
}

function makeClient(
  overrides: Partial<OAuthClientInformationFull> = {},
): OAuthClientInformationFull {
  return {
    client_id: `client_${randomBytes(8).toString("hex")}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Claude",
    client_secret: "secret_value",
    client_secret_expires_at: Math.floor(Date.now() / 1000) + 86400,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    ...overrides,
  };
}

describe("isAllowedMcpOAuthRedirectUri", () => {
  it("accepts https redirect URIs for any host", () => {
    expect(isAllowedMcpOAuthRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(
      isAllowedMcpOAuthRedirectUri("https://chatgpt.com/connector/oauth/callback_abc123"),
    ).toBe(true);
    expect(isAllowedMcpOAuthRedirectUri("https://app.example.com/oauth/callback")).toBe(true);
  });

  it("accepts http redirect URIs on loopback hosts", () => {
    expect(isAllowedMcpOAuthRedirectUri("http://localhost:8787/callback")).toBe(true);
    expect(isAllowedMcpOAuthRedirectUri("http://127.0.0.1:33418/oauth/callback")).toBe(true);
  });

  it("rejects unsafe or non-https remote redirect URIs", () => {
    expect(isAllowedMcpOAuthRedirectUri("http://evil.example.com/callback")).toBe(false);
    expect(isAllowedMcpOAuthRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedMcpOAuthRedirectUri("data:text/html,hi")).toBe(false);
    expect(isAllowedMcpOAuthRedirectUri("https://example.com/cb#fragment")).toBe(false);
    expect(isAllowedMcpOAuthRedirectUri("https://user:pass@example.com/cb")).toBe(false);
    expect(isAllowedMcpOAuthRedirectUri("not-a-url")).toBe(false);
  });
});

describe("McpOAuthClientsStore", () => {
  describe("registerClient", () => {
    it("rejects empty redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient({ redirect_uris: [] });

      await expect(store.registerClient(client)).rejects.toThrow(InvalidClientMetadataError);
    });

    it("rejects unsafe redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient({ redirect_uris: ["http://evil.example.com/callback"] });

      await expect(store.registerClient(client)).rejects.toThrow(InvalidClientMetadataError);
      await expect(store.registerClient(client)).rejects.toThrow("Invalid redirect_uri");
    });

    it("accepts valid Claude redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient();

      const result = await store.registerClient(client);
      expect(result.client_id).toBe(client.client_id);
      expect(db.execute).toHaveBeenCalledOnce();
    });

    it("accepts arbitrary https MCP client redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient({
        client_name: "Cursor",
        redirect_uris: ["https://cursor.example/oauth/mcp/callback"],
      });

      const result = await store.registerClient(client);
      expect(result.client_id).toBe(client.client_id);
      expect(db.execute).toHaveBeenCalledOnce();
    });

    it("accepts localhost http redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient({
        client_name: "Local Inspector",
        redirect_uris: ["http://127.0.0.1:6274/oauth/callback"],
      });

      const result = await store.registerClient(client);
      expect(result.client_id).toBe(client.client_id);
      expect(db.execute).toHaveBeenCalledOnce();
    });
  });

  describe("getClient", () => {
    it("returns undefined for non-existent client", async () => {
      const db = makeMockDb();
      db.execute.mockResolvedValue([]);
      const store = new McpOAuthClientsStore(db);

      const result = await store.getClient("nonexistent");
      expect(result).toBeUndefined();
    });

    it("maps null client_id_issued_at to undefined", async () => {
      const db = makeMockDb();
      db.execute.mockResolvedValue([
        {
          client_id: "test_client",
          client_id_issued_at: null,
          client_metadata: {
            client_name: "Claude",
            grant_types: ["authorization_code"],
            redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
            response_types: ["code"],
            token_endpoint_auth_method: "client_secret_post",
          },
          client_secret: null,
          client_secret_expires_at: null,
        },
      ]);
      const store = new McpOAuthClientsStore(db);

      const result = await store.getClient("test_client");
      expect(result).toBeDefined();
      expect(result?.client_id_issued_at).toBeUndefined();
      expect(result?.client_secret_expires_at).toBeUndefined();
    });
  });
});
