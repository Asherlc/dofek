import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { Router } from "express";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { getAccessWindowForUser } from "../billing/access-window-repository.ts";
import { exportActivityFile } from "../lib/activity-export-service.ts";
import { requestTimezoneSchema } from "../lib/request-timezone.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";

const exportFormatSchema = z.enum(["gpx", "tcx", "csv", "fit"]);
const activityIdSchema = z.guid();

interface ActivityExportRouterDeps {
  db: Database;
  sensorStore: ActivitySensorStore;
}

export function createActivityExportRouter({ db, sensorStore }: ActivityExportRouterDeps): Router {
  const router = Router();

  router.get("/:activityId/export", async (req, res) => {
    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const session = await validateSession(db, sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }

    const activityIdResult = activityIdSchema.safeParse(req.params.activityId);
    if (!activityIdResult.success) {
      res.status(400).json({ error: "Invalid activity id" });
      return;
    }

    const formatResult = exportFormatSchema.safeParse(req.query.format);
    if (!formatResult.success) {
      res.status(400).json({ error: "Invalid export format" });
      return;
    }

    const timezoneResult = requestTimezoneSchema.safeParse(req.get("x-timezone"));
    if (!timezoneResult.success) {
      res.status(400).json({ error: "Invalid x-timezone header" });
      return;
    }
    const timezone = timezoneResult.data;
    const accessWindow = await getAccessWindowForUser(db, session.userId, timezone);

    try {
      const exported = await exportActivityFile(
        db,
        session.userId,
        timezone,
        accessWindow,
        sensorStore,
        activityIdResult.data,
        formatResult.data,
      );

      res.status(200);
      res.setHeader("Content-Type", exported.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`);
      res.end(exported.body);
    } catch (error) {
      if (error instanceof TRPCError) {
        if (error.code === "NOT_FOUND") {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error.code === "BAD_REQUEST") {
          res.status(400).json({ error: error.message });
          return;
        }
      }
      throw error;
    }
  });

  return router;
}
