import type { Database } from "dofek/db";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const credentialEncryptionMocks = vi.hoisted(() => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));
vi.mock("dofek/security/credential-encryption", () => ({
  decryptCredentialValue: credentialEncryptionMocks.decrypt,
  encryptCredentialValue: credentialEncryptionMocks.encrypt,
}));

import {
  createMcpOidcAdapter,
  McpOidcAdapter,
  resolveAdapterUserId,
  resolveExpiresAt,
} from "./adapter.ts";

const mockExecute = vi.fn();

function mockDb(): Pick<Database, "execute"> {
  return { execute: mockExecute };
}

function isStringChunk(chunk: unknown): chunk is { value: unknown[] } {
  return (
    typeof chunk === "object" && chunk !== null && "value" in chunk && Array.isArray(chunk.value)
  );
}

/** Raw bound values from a drizzle `sql` template, in placeholder order. */
function sqlParams(query: SQL): unknown[] {
  return query.queryChunks.filter((chunk) => !isStringChunk(chunk));
}

function executedParams(callIndex = 0): unknown[] {
  return sqlParams(mockExecute.mock.calls[callIndex]?.[0]);
}

function executedSql(callIndex = 0): string {
  const query: SQL = mockExecute.mock.calls[callIndex]?.[0];
  return query.queryChunks
    .map((chunk) => (isStringChunk(chunk) ? chunk.value.join("") : ""))
    .join("");
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date)) throw new Error("expected a Date value");
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue([]);
  credentialEncryptionMocks.encrypt.mockImplementation(async (value) => `encrypted:${value}`);
  credentialEncryptionMocks.decrypt.mockImplementation(async (value) =>
    value.replace(/^encrypted:/, ""),
  );
});

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

  it("returns null for non-uuid values so invalid values never attribute", () => {
    expect(resolveAdapterUserId("not-a-uuid")).toBeNull();
    expect(resolveAdapterUserId(123)).toBeNull();
  });
});

describe("resolveExpiresAt", () => {
  it("returns null when expiresIn is undefined", () => {
    expect(resolveExpiresAt(undefined)).toBeNull();
  });

  it("converts a numeric lifetime into an absolute timestamp", () => {
    const before = Date.now();
    const expiresAt = requireDate(resolveExpiresAt(60));
    const after = Date.now();
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);
  });

  it("resolves a zero lifetime to approximately now", () => {
    const before = Date.now();
    const expiresAt = requireDate(resolveExpiresAt(0));
    const after = Date.now();
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("McpOidcAdapter upsert", () => {
  it("hashes session ids and derives ownership from accountId", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Session");
    await adapter.upsert(
      "session-id",
      {
        uid: "session-uid",
        accountId: "123e4567-e89b-12d3-a456-426614174000",
        userCode: "code-1",
        grantId: "grant-1",
      },
      60,
    );
    const params = executedParams();
    // Placeholder order: model, id, payload, uid, user_id, user_code, grant_id, expires_at.
    expect(params[0]).toBe("Session");
    expect(params[1]).not.toBe("session-id");
    expect(params[3]).toBe("session-uid");
    expect(params[4]).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params[5]).toBe("code-1");
    expect(params[6]).toBe("grant-1");
    expect(requireDate(params[7]).getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("writes null ownership and lookup columns when the payload has none", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Client");
    await adapter.upsert("client-id", { client_id: "x" });
    const params = executedParams();
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  it("leaves user_id null for non-uuid account identifiers", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Session");
    await adapter.upsert("session-id", { accountId: "not-a-uuid" });
    const params = executedParams();
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });
});

describe("McpOidcAdapter find", () => {
  it("returns the payload for a stored unexpired artifact", async () => {
    mockExecute.mockResolvedValue([{ payload: { foo: "bar" }, expires_at: null }]);
    const adapter = new McpOidcAdapter(mockDb(), "AccessToken");
    await expect(adapter.find("token-id")).resolves.toEqual({ foo: "bar" });
    expect(executedSql()).toContain("id =");
    expect(executedParams()).not.toContain("token-id");
  });

  it("looks up sessions by uid", async () => {
    mockExecute.mockResolvedValue([{ payload: { uid: "user-1" }, expires_at: null }]);
    const adapter = new McpOidcAdapter(mockDb(), "Session");
    await expect(adapter.findByUid("user-1")).resolves.toEqual({ uid: "user-1" });
    expect(executedSql()).toContain("uid =");
  });

  it("looks up device codes by user_code", async () => {
    mockExecute.mockResolvedValue([{ payload: { userCode: "code-1" }, expires_at: null }]);
    const adapter = new McpOidcAdapter(mockDb(), "DeviceCode");
    await expect(adapter.findByUserCode("code-1")).resolves.toEqual({
      userCode: "code-1",
    });
    expect(executedSql()).toContain("user_code =");
  });

  it("returns undefined when no row exists", async () => {
    mockExecute.mockResolvedValue([]);
    const adapter = new McpOidcAdapter(mockDb(), "AccessToken");
    await expect(adapter.find("missing")).resolves.toBeUndefined();
  });

  it("returns undefined for expired artifacts", async () => {
    mockExecute.mockResolvedValue([
      { payload: { foo: "bar" }, expires_at: new Date(Date.now() - 1000) },
    ]);
    const adapter = new McpOidcAdapter(mockDb(), "AccessToken");
    await expect(adapter.find("token-id")).resolves.toBeUndefined();
  });

  it("treats an exact-now expiry as expired", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      mockExecute.mockResolvedValue([{ payload: { foo: "bar" }, expires_at: new Date(now) }]);
      const adapter = new McpOidcAdapter(mockDb(), "AccessToken");
      await expect(adapter.find("token-id")).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("treats unparseable expiry values as unexpired", async () => {
    mockExecute.mockResolvedValue([{ payload: { foo: "bar" }, expires_at: "not-a-date" }]);
    const adapter = new McpOidcAdapter(mockDb(), "AccessToken");
    await expect(adapter.find("token-id")).resolves.toEqual({ foo: "bar" });
  });
});

describe("McpOidcAdapter consume", () => {
  it("atomically updates consumed without rewriting the artifact or expiry", async () => {
    mockExecute.mockResolvedValueOnce([]);
    const adapter = new McpOidcAdapter(mockDb(), "AuthorizationCode");
    await adapter.consume("code-id");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(executedSql()).toContain("jsonb_set");
    expect(executedSql()).not.toContain("expires_at =");
    expect(executedParams()).toContain("AuthorizationCode");
  });
});

describe("McpOidcAdapter Client secrets", () => {
  it("encrypts client secrets before persistence and decrypts them on read", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Client");
    await adapter.upsert("client-1", { client_id: "client-1", client_secret: "secret" });
    expect(executedParams()[2]).toMatchObject({ client_secret: "encrypted:secret" });

    mockExecute.mockResolvedValueOnce([
      { payload: { client_id: "client-1", client_secret: "encrypted:secret" }, expires_at: null },
    ]);
    await expect(adapter.find("client-1")).resolves.toMatchObject({ client_secret: "secret" });
  });

  it("decrypts migrated legacy client secrets with their original encryption context", async () => {
    const adapter = new McpOidcAdapter(mockDb(), "Client");
    mockExecute.mockResolvedValueOnce([
      {
        payload: {
          client_id: "legacy-client",
          client_secret: "encrypted:legacy-secret",
          dofekLegacyEncryptedClientSecret: true,
        },
        expires_at: null,
      },
    ]);
    await expect(adapter.find("legacy-client")).resolves.toMatchObject({
      client_secret: "legacy-secret",
    });
    expect(credentialEncryptionMocks.decrypt).toHaveBeenCalledWith(
      "encrypted:legacy-secret",
      expect.objectContaining({ tableName: "fitness.mcp_oauth_client" }),
    );
  });
});

describe("McpOidcAdapter destroy", () => {
  it("removes the artifact by id", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "Client");
    await adapter.destroy("client-id");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(executedSql()).toContain("id =");
    expect(executedParams()).toContain("client-id");
  });

  it("revokes artifacts sharing a grant", async () => {
    const db = mockDb();
    const adapter = new McpOidcAdapter(db, "AccessToken");
    await adapter.revokeByGrantId("grant-1");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(executedSql()).toContain("grant_id =");
    expect(executedParams()).toContain("grant-1");
  });
});
