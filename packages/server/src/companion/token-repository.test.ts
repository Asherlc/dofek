import { describe, expect, it, vi } from "vitest";
import {
  createOrGetCompanionToken,
  generateCompanionToken,
  hashCompanionToken,
  regenerateCompanionToken,
  revokeCompanionToken,
  revokeCompanionTokenByToken,
  validateCompanionToken,
} from "./token-repository.ts";

function createMockDb() {
  return {
    execute: vi.fn(),
  };
}

describe("token-repository", () => {
  describe("generateCompanionToken", () => {
    it("generates a token with dofek_companion_ prefix", () => {
      const token = generateCompanionToken();
      expect(token).toMatch(/^dofek_companion_/);
    });

    it("generates unique tokens each time", () => {
      const t1 = generateCompanionToken();
      const t2 = generateCompanionToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe("hashCompanionToken", () => {
    it("returns a sha256 hex string of the token", () => {
      const token = "test-token";
      const hash = hashCompanionToken(token);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("returns the same hash for the same token", () => {
      const token = "test-token";
      expect(hashCompanionToken(token)).toBe(hashCompanionToken(token));
    });

    it("returns different hashes for different tokens", () => {
      expect(hashCompanionToken("token-a")).not.toBe(hashCompanionToken("token-b"));
    });
  });

  describe("validateCompanionToken", () => {
    it("returns user_id when token is valid and not revoked", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([{ user_id: "user-123", connection_type: "zepp-main" }]);
      const result = await validateCompanionToken(db, "valid-token");
      expect(result).toBe("user-123");
    });

    it("returns null when token is not found", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([]);
      const result = await validateCompanionToken(db, "unknown-token");
      expect(result).toBeNull();
    });
  });

  describe("createOrGetCompanionToken", () => {
    it("creates a new token when no existing token exists", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([
        {
          id: "token-id",
          user_id: "user-123",
          connection_type: "zepp-main",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: null,
        },
      ]);
      const result = await createOrGetCompanionToken(db, "user-123");
      expect(result.id).toBe("token-id");
      expect(result.token).not.toBeNull();
      expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result.revokedAt).toBeNull();
    });

    it("returns existing token metadata when token already exists", async () => {
      const db = createMockDb();
      db.execute
        .mockResolvedValueOnce([]) // INSERT ON CONFLICT DO NOTHING returns nothing
        .mockResolvedValueOnce([
          {
            id: "existing-id",
            user_id: "user-123",
            connection_type: "zepp-main",
            created_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
          },
        ]); // SELECT returns existing row
      const result = await createOrGetCompanionToken(db, "user-123");
      expect(result.id).toBe("existing-id");
      expect(result.token).toBeNull();
      expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("throws when no active row exists after conflict", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await expect(createOrGetCompanionToken(db, "user-123")).rejects.toThrow(
        "Failed to create companion token",
      );
    });
  });

  describe("regenerateCompanionToken", () => {
    it("revokes existing token and creates a new one", async () => {
      const transaction = createMockDb();
      transaction.execute
        .mockResolvedValueOnce([
          {
            acquired: true,
          },
        ]) // Acquire advisory lock
        .mockResolvedValueOnce([]) // UPDATE revoke
        .mockResolvedValueOnce([
          {
            id: "new-id",
            user_id: "user-123",
            connection_type: "zepp-main",
            created_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
          },
        ]); // INSERT ... ON CONFLICT ... RETURNING
      let transactionCallCount = 0;
      const db = {
        execute: vi.fn(),
        transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> => {
          transactionCallCount += 1;
          return callback(transaction);
        },
      };

      const result = await regenerateCompanionToken(db, "user-123");

      expect(result.id).toBe("new-id");
      expect(result.token).not.toBeNull();
      expect(transactionCallCount).toBe(1);
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("returns a conflict result without revoking an active token", async () => {
      const transaction = createMockDb();
      transaction.execute
        .mockResolvedValueOnce([
          {
            acquired: false,
          },
        ]) // Fail to acquire advisory lock
        .mockResolvedValueOnce([
          {
            id: "new-id",
            user_id: "user-123",
            connection_type: "zepp-main",
            created_at: "2026-01-01T00:01:00.000Z",
            revoked_at: null,
          },
        ]); // SELECT active token
      const db = {
        transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> =>
          callback(transaction),
      };

      const result = await regenerateCompanionToken(db, "user-123");

      expect(result).toEqual({
        id: "new-id",
        connectionType: "zepp-main",
        token: null,
        createdAt: "2026-01-01T00:01:00.000Z",
        revokedAt: null,
      });
      expect(transaction.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("revokeCompanionToken", () => {
    it("returns true when an active connection is revoked", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([
        {
          id: "token-id",
          user_id: "user-123",
          connection_type: "zepp-main",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: "2026-01-02T00:00:00.000Z",
        },
      ]);

      await expect(revokeCompanionToken(db, "user-123", "zepp-main")).resolves.toBe(true);
    });

    it("returns false when no active connection exists", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([]);

      await expect(revokeCompanionToken(db, "user-123", "zepp-main")).resolves.toBe(false);
    });
  });

  describe("revokeCompanionTokenByToken", () => {
    it("returns true when the bearer token identifies an active connection", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([
        {
          id: "token-id",
          user_id: "user-123",
          connection_type: "zepp-workout",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: "2026-01-02T00:00:00.000Z",
        },
      ]);

      await expect(revokeCompanionTokenByToken(db, "dofek_companion_token")).resolves.toBe(true);
    });

    it("returns false when the bearer token has no active connection", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([]);

      await expect(revokeCompanionTokenByToken(db, "dofek_companion_token")).resolves.toBe(false);
    });
  });
});
