import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession, deleteExpiredSessions, deleteSession, validateSession } from "./session.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

describe("Auth session (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
  });

  describe("createSession", () => {
    it("creates a session and returns sessionId, userId, and expiresAt", async () => {
      const result = await createSession(ctx.db, TEST_USER_ID);

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).toHaveLength(64); // 32 bytes hex
      expect(result.userId).toBe(TEST_USER_ID);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("creates unique session tokens for each call", async () => {
      const session1 = await createSession(ctx.db, TEST_USER_ID);
      const session2 = await createSession(ctx.db, TEST_USER_ID);

      expect(session1.sessionId).not.toBe(session2.sessionId);
    });

    it("persists session in the database", async () => {
      const session = await createSession(ctx.db, TEST_USER_ID);

      const rows = await ctx.db.execute<{ id: string; user_id: string }>(
        sql`SELECT id, user_id FROM fitness.session WHERE id = ${session.sessionId}`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.user_id).toBe(TEST_USER_ID);
    });
  });

  describe("validateSession", () => {
    it("returns userId for a valid, non-expired session", async () => {
      const session = await createSession(ctx.db, TEST_USER_ID);

      const result = await validateSession(ctx.db, session.sessionId);

      expect(result).not.toBeNull();
      expect(result?.userId).toBe(TEST_USER_ID);
    });

    it("returns null for a non-existent session", async () => {
      const result = await validateSession(ctx.db, "nonexistent-session-token");
      expect(result).toBeNull();
    });

    it("returns null for an expired session", async () => {
      // Insert a session that expired in the past
      const expiredSessionId = `expired-session-${Date.now().toString(16)}`;
      await ctx.db.execute(
        sql`INSERT INTO fitness.session (id, user_id, expires_at)
            VALUES (${expiredSessionId}, ${TEST_USER_ID}, ${new Date("2020-01-01").toISOString()})`,
      );

      const result = await validateSession(ctx.db, expiredSessionId);
      expect(result).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("removes the session from the database", async () => {
      const session = await createSession(ctx.db, TEST_USER_ID);

      await deleteSession(ctx.db, session.sessionId);

      const result = await validateSession(ctx.db, session.sessionId);
      expect(result).toBeNull();
    });

    it("does not throw when deleting a non-existent session", async () => {
      await expect(deleteSession(ctx.db, "nonexistent-token")).resolves.not.toThrow();
    });
  });

  describe("deleteExpiredSessions", () => {
    it("removes expired sessions but keeps valid ones", async () => {
      // Create a valid session
      const validSession = await createSession(ctx.db, TEST_USER_ID);

      // Insert an expired session
      const expiredId = `expired-${Date.now().toString(16)}`;
      await ctx.db.execute(
        sql`INSERT INTO fitness.session (id, user_id, expires_at)
            VALUES (${expiredId}, ${TEST_USER_ID}, ${new Date("2020-01-01").toISOString()})`,
      );

      await deleteExpiredSessions(ctx.db);

      // Valid session should still exist
      const valid = await validateSession(ctx.db, validSession.sessionId);
      expect(valid).not.toBeNull();

      // Expired session should be gone
      const rows = await ctx.db.execute(
        sql`SELECT id FROM fitness.session WHERE id = ${expiredId}`,
      );
      expect(rows.length).toBe(0);
    });

    it("handles case with no expired sessions", async () => {
      await createSession(ctx.db, TEST_USER_ID);

      await expect(deleteExpiredSessions(ctx.db)).resolves.not.toThrow();
    });
  });
});
