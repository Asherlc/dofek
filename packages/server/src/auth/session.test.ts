import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, deleteExpiredSessions, deleteSession, validateSession } from "./session.ts";

const mockExecute = vi.fn();

function createMockDb() {
  return { execute: mockExecute };
}

type MockDb = ReturnType<typeof createMockDb>;

describe("session", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
    mockDb = createMockDb();
  });

  describe("createSession", () => {
    it("inserts a session and returns session info", async () => {
      const result = await createSession(mockDb, "user-123");

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.userId).toBe("user-123");
      expect(result.sessionId).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(result.expiresAt).toBeInstanceOf(Date);
      // Expires ~30 days from now
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const diff = result.expiresAt.getTime() - Date.now();
      expect(diff).toBeGreaterThan(thirtyDaysMs - 1000);
      expect(diff).toBeLessThanOrEqual(thirtyDaysMs);
    });

    it("generates unique session tokens", async () => {
      const result1 = await createSession(mockDb, "user-1");
      const result2 = await createSession(mockDb, "user-1");

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("generates hex-only session tokens", async () => {
      const result = await createSession(mockDb, "user-1");
      expect(result.sessionId).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("validateSession", () => {
    it("returns userId when session is valid", async () => {
      mockExecute.mockResolvedValue([{ user_id: "user-abc", expires_at: new Date("2027-01-01") }]);

      const result = await validateSession(mockDb, "session-token");

      expect(result).toEqual({ userId: "user-abc" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("returns null when no matching session exists", async () => {
      mockExecute.mockResolvedValue([]);

      const result = await validateSession(mockDb, "nonexistent");

      expect(result).toBeNull();
    });

    it("returns null when row is undefined", async () => {
      mockExecute.mockResolvedValue([undefined]);

      const result = await validateSession(mockDb, "bad-session");

      expect(result).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("executes a DELETE query", async () => {
      await deleteSession(mockDb, "session-to-delete");

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteExpiredSessions", () => {
    it("executes a DELETE for expired sessions", async () => {
      await deleteExpiredSessions(mockDb);

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });
});
