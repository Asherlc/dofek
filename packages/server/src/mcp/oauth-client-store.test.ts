import { randomBytes } from "node:crypto";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it, vi } from "vitest";
import { McpOAuthClientsStore } from "./oauth-client-store.ts";

function makeMockDb() {
  return {
    execute: vi.fn().mockResolvedValue([]),
  };
}

function makeClient(overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
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

describe("McpOAuthClientsStore", () => {
  describe("registerClient", () => {
    it("rejects empty redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient({ redirect_uris: [] });

      await expect(store.registerClient(client)).rejects.toThrow(InvalidClientMetadataError);
    });

    it("rejects non-Claude redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient({ redirect_uris: ["https://evil.example.com/callback"] });

      await expect(store.registerClient(client)).rejects.toThrow(InvalidClientMetadataError);
    });

    it("accepts valid Claude redirect URIs", async () => {
      const db = makeMockDb();
      const store = new McpOAuthClientsStore(db);
      const client = makeClient();

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
