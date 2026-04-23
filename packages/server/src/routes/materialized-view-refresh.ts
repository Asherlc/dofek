import * as Sentry from "@sentry/node";
import { syncMaterializedViews } from "dofek/db/sync-views";
import { Router } from "express";
import { logger } from "../logger.ts";

let activeRefreshRun: Promise<void> | null = null;

function getBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function createMaterializedViewRefreshRouter(): Router {
  const router = Router();

  router.post("/materialized-views/refresh", (req, res) => {
    const configuredToken = process.env.MATERIALIZED_VIEW_REFRESH_TOKEN;
    if (!configuredToken) {
      res.status(500).json({
        error: "MATERIALIZED_VIEW_REFRESH_TOKEN environment variable is required",
      });
      return;
    }

    const authorizationHeader =
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    const providedToken = getBearerToken(authorizationHeader);
    if (!providedToken || providedToken !== configuredToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      res.status(500).json({
        error: "DATABASE_URL environment variable is required",
      });
      return;
    }

    if (activeRefreshRun) {
      res.status(202).json({ status: "already_running" });
      return;
    }

    activeRefreshRun = (async () => {
      try {
        logger.info("[views-refresh] Started");
        const result = await syncMaterializedViews(databaseUrl);
        logger.info(
          `[views-refresh] Done — ${result.synced} recreated, ${result.skipped} unchanged` +
            (result.refreshed > 0 ? `, ${result.refreshed} refreshed` : ""),
        );
      } catch (error) {
        logger.error(`[views-refresh] Failed: ${error}`);
        Sentry.captureException(error);
      } finally {
        activeRefreshRun = null;
      }
    })();

    res.status(202).json({ status: "started" });
  });

  return router;
}
