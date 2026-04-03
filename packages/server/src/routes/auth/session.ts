import { sql } from "drizzle-orm";
import type { Router } from "express";
import { z } from "zod";
import { clearSessionCookie, getSessionIdFromRequest } from "../../auth/cookies.ts";
import { deleteSession, validateSession } from "../../auth/session.ts";
import { executeWithSchema } from "../../lib/typed-sql.ts";
import { logger } from "../../logger.ts";
import { getDb } from "./shared.ts";

export function registerSessionRoutes(router: Router): void {
  router.post("/auth/logout", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (sessionId) {
      await deleteSession(getDb(), sessionId);
      clearSessionCookie(res);
    }
    res.json({ ok: true });
  });

  router.get("/api/auth/me", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const db = getDb();
    const session = await validateSession(db, sessionId);
    if (!session) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Session expired" });
      return;
    }
    const rows = await executeWithSchema(
      db,
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().nullable(),
        is_admin: z.boolean(),
      }),
      sql`SELECT id, name, email, is_admin FROM fitness.user_profile WHERE id = ${session.userId}`,
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    const userAgent = req.headers["user-agent"] ?? "unknown";
    const isMobile = userAgent.includes("Darwin") || userAgent.includes("CFNetwork");
    if (isMobile) {
      logger.info(`[auth] /me resolved userId=${session.userId} (mobile)`);
    }
    const row = rows[0];
    if (!row) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json({ id: row.id, name: row.name, email: row.email, isAdmin: row.is_admin });
  });
}
