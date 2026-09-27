import { describe, expect, it, vi } from "vitest";
import { McpOAuthClientsStore } from "./oauth-client-store.ts";

function makeMockDb() {
  return {
    execute: vi.fn().mockResolvedValue([]),
  };
}

describe("McpOAuthClientsStore", () => {
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
