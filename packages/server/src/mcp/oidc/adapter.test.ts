import type { Database } from "dofek/db";
import { describe, expect, it, vi } from "vitest";
import { createMcpOidcAdapter, McpOidcAdapter, resolveAdapterUserId } from "./adapter.ts";

function mockDb(): Pick<Database, "execute"> {
  return { execute: vi.fn() };
}

describe("createMcpOidcAdapter", () => {
  it("is a factory that returns a per-model adapter instance", () => {
    const factory = createMcpOidcAdapter(mockDb());
    const client = factory("Client");
    const session = factory("Session");
    expect(client).toBeInstanceOf(McpOidcAdapter);
    expect(client.model).toBe("Client");
    expect(session.model).toBe("Session");
  });
});

describe("McpOidcAdapter", () => {
  it("upserts a payload with an expires_at date when expiresIn is numeric", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "AccessToken");
    await adapter.upsert("token-id", { foo: "bar" }, 60);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("does not write expires_at when expiresIn is undefined", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Client");
    await adapter.upsert("client-id", { client_id: "x" });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("destroy removes the artifact by id", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Client");
    await adapter.destroy("client-id");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("revokeByGrantId removes artifacts sharing a grant", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "AccessToken");
    await adapter.revokeByGrantId("grant-1");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAdapterUserId", () => {
  it("maps a uuid uid to user_id for account-erasure ownership", () => {
    expect(resolveAdapterUserId("123e4567-e89b-12d3-a456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("returns null when uid is missing so shared artifacts stay unowned", () => {
    expect(resolveAdapterUserId(undefined)).toBeNull();
    expect(resolveAdapterUserId(null)).toBeNull();
  });

  it("returns null for non-uuid uids so invalid values never attribute", () => {
    expect(resolveAdapterUserId("not-a-uuid")).toBeNull();
    expect(resolveAdapterUserId(123)).toBeNull();
  });
});
