import { describe, expect, it, vi } from "vitest";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  validateSession,
} from "../auth/session.ts";

function createMockDb(rows: Record<string, unknown>[] = []) {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  };
}

describe("session", () => {
  describe("createSession", () => {
    it("creates a session and returns session info", async () => {
      const db = createMockDb();
      const result = await createSession(db, "user-123");

      expect(result.userId).toBe("user-123");
      expect(result.sessionId).toMatch(/^[0-9a-f]{64}$/);
      expect(result.expiresAt).toBeInstanceOf(Date);
      // Session should expire roughly 30 days from now
      const expectedExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000);
      expect(result.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000);
    });

    it("generates unique session tokens", async () => {
      const db = createMockDb();
      const session1 = await createSession(db, "user-123");
      const session2 = await createSession(db, "user-123");

      expect(session1.sessionId).not.toBe(session2.sessionId);
    });

    it("calls db.execute with INSERT statement", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const db = { execute: mockExecute };

      await createSession(db, "user-456");

      expect(mockExecute).toHaveBeenCalledOnce();
    });
  });

  describe("validateSession", () => {
    it("returns userId when session is valid", async () => {
      const db = createMockDb([
        { user_id: "user-123", expires_at: new Date(Date.now() + 86400000) },
      ]);

      const result = await validateSession(db, "valid-session-id");

      expect(result).toEqual({ userId: "user-123" });
    });

    it("returns null when session not found", async () => {
      const db = createMockDb([]);

      const result = await validateSession(db, "nonexistent");

      expect(result).toBeNull();
    });

    it("returns null when rows array is empty", async () => {
      const db = createMockDb([]);

      const result = await validateSession(db, "expired-session");

      expect(result).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("calls db.execute to delete session", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const db = { execute: mockExecute };

      await deleteSession(db, "session-to-delete");

      expect(mockExecute).toHaveBeenCalledOnce();
    });
  });

  describe("deleteExpiredSessions", () => {
    it("calls db.execute to delete expired sessions", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const db = { execute: mockExecute };

      await deleteExpiredSessions(db);

      expect(mockExecute).toHaveBeenCalledOnce();
    });
  });
});
