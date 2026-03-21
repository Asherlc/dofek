import { randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const SESSION_DURATION_DAYS = 30;

/** Generate a cryptographically random session token (64 hex chars). */
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

const sessionRowSchema = z.object({
  user_id: z.string(),
});

/** Create a new session for a user. Returns the session token and expiry. */
export async function createSession(db: Database, userId: string): Promise<SessionInfo> {
  const sessionId = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

  await db.execute(
    sql`INSERT INTO fitness.session (id, user_id, expires_at)
        VALUES (${sessionId}, ${userId}, ${expiresAt.toISOString()})`,
  );

  return { sessionId, userId, expiresAt };
}

/** Validate a session token. Returns userId if valid and not expired, null otherwise. */
export async function validateSession(
  db: Database,
  sessionId: string,
): Promise<{ userId: string } | null> {
  const rows = await executeWithSchema(
    db,
    sessionRowSchema,
    sql`SELECT user_id FROM fitness.session
        WHERE id = ${sessionId} AND expires_at > NOW()
        LIMIT 1`,
  );

  const row = rows[0];
  if (!row) return null;
  return { userId: row.user_id };
}

/** Delete a session (logout). */
export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  await db.execute(sql`DELETE FROM fitness.session WHERE id = ${sessionId}`);
}

/** Delete all expired sessions (cleanup). */
export async function deleteExpiredSessions(db: Database): Promise<void> {
  await db.execute(sql`DELETE FROM fitness.session WHERE expires_at <= NOW()`);
}
