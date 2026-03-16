import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  validateSession,
} from "../session.ts";

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
      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result = await createSession(mockDb as any, "user-123");

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
      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result1 = await createSession(mockDb as any, "user-1");
      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result2 = await createSession(mockDb as any, "user-1");

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("generates hex-only session tokens", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result = await createSession(mockDb as any, "user-1");
      expect(result.sessionId).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("validateSession", () => {
    it("returns userId when session is valid", async () => {
      mockExecute.mockResolvedValue([{ user_id: "user-abc", expires_at: new Date("2027-01-01") }]);

      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result = await validateSession(mockDb as any, "session-token");

      expect(result).toEqual({ userId: "user-abc" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("returns null when no matching session exists", async () => {
      mockExecute.mockResolvedValue([]);

      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result = await validateSession(mockDb as any, "nonexistent");

      expect(result).toBeNull();
    });

    it("returns null when row is undefined", async () => {
      mockExecute.mockResolvedValue([undefined]);

      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      const result = await validateSession(mockDb as any, "bad-session");

      expect(result).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("executes a DELETE query", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      await deleteSession(mockDb as any, "session-to-delete");

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteExpiredSessions", () => {
    it("executes a DELETE for expired sessions", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock DB
      await deleteExpiredSessions(mockDb as any);

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });
});
