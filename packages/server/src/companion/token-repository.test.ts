import { describe, expect, it, vi } from "vitest";
import {
  createOrGetCompanionToken,
  generateCompanionToken,
  hashCompanionToken,
  regenerateCompanionToken,
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
      db.execute.mockResolvedValueOnce([{ user_id: "user-123" }]);
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
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: "token-id",
          user_id: "user-123",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: null,
        },
      ]);
      const result = await createOrGetCompanionToken(db, "user-123");
      expect(result.id).toBe("token-id");
      expect(result.token).not.toBe("");
      expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(result.revokedAt).toBeNull();
    });

    it("returns existing token metadata when token already exists", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([{ token_hash: "exists" }]).mockResolvedValueOnce([
        {
          id: "existing-id",
          user_id: "user-123",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: null,
        },
      ]);
      const result = await createOrGetCompanionToken(db, "user-123");
      expect(result.id).toBe("existing-id");
      expect(result.token).toBeNull();
      expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("throws when existing token row is not found after initial check", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([{ token_hash: "exists" }]).mockResolvedValueOnce([]);
      await expect(createOrGetCompanionToken(db, "user-123")).rejects.toThrow(
        "Companion token not found after creation",
      );
    });

    it("throws when insert returns no rows", async () => {
      const db = createMockDb();
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await expect(createOrGetCompanionToken(db, "user-123")).rejects.toThrow(
        "Failed to create companion token",
      );
    });
  });

  describe("regenerateCompanionToken", () => {
    it("revokes existing token and creates a new one", async () => {
      const db = createMockDb();
      db.execute
        .mockResolvedValueOnce([]) // BEGIN
        .mockResolvedValueOnce([]) // UPDATE revoke
        .mockResolvedValueOnce([]) // SELECT token_hash (no existing after revoke)
        .mockResolvedValueOnce([
          {
            id: "new-id",
            user_id: "user-123",
            created_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
          },
        ]) // INSERT RETURNING
        .mockResolvedValueOnce([]); // COMMIT
      const result = await regenerateCompanionToken(db, "user-123");
      expect(result.id).toBe("new-id");
      expect(result.token).not.toBeNull();
    });
  });
});
