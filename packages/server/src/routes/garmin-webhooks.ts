import { timingSafeEqual } from "node:crypto";
import type { SyncDatabase } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { findTokenUsersByProviderAccountId, loadTokens } from "dofek/db/tokens";
import { captureException } from "dofek/lib/error-reporting";
import { readGarminDeliveryState } from "dofek/providers/garmin/authorization";
import { parseGarminWebhookPayload } from "dofek/providers/garmin/payloads";
import type { WebhookEvent } from "dofek/providers/types";
import { type ErrorRequestHandler, Router, raw } from "express";
import { z } from "zod";

interface GarminWebhookRouterDependencies {
  db: SyncDatabase;
  sharedSecret: string | undefined;
  enqueueEvent(userId: string, event: WebhookEvent): Promise<void>;
}

export function createGarminWebhookRouter({
  db,
  sharedSecret,
  enqueueEvent,
}: GarminWebhookRouterDependencies): Router {
  const router = Router();

  router.post(
    "/",
    (req, res, next) => {
      if (!sharedSecret || Buffer.byteLength(sharedSecret) < 32) {
        res
          .status(503)
          .json({ error: "GARMIN_WEBHOOK_SECRET must contain at least 32 characters" });
        return;
      }
      const suppliedToken = req.query.token;
      const expected = Buffer.from(sharedSecret);
      const supplied = typeof suppliedToken === "string" ? Buffer.from(suppliedToken) : null;
      if (
        !supplied ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.status(401).json({ error: "Invalid Garmin receiver token" });
        return;
      }
      next();
    },
    raw({ type: () => true, limit: "1mb", inflate: false }),
    async (req, res) => {
      let events: WebhookEvent[];
      try {
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: "Garmin notification must contain a JSON body" });
          return;
        }
        events = parseGarminWebhookPayload(JSON.parse(req.body.toString("utf8")));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          res.status(400).json({ error: "Invalid Garmin notification payload" });
          return;
        }
        captureException(error, { tags: { provider: "garmin", operation: "webhook-parse" } });
        res.status(503).json({ error: "Garmin notification parsing failed; retry delivery" });
        return;
      }

      let failed = false;
      try {
        for (const event of events) {
          const userIds = await findTokenUsersByProviderAccountId(
            db,
            "garmin",
            event.ownerExternalId,
          );
          if (userIds.length > 1) {
            throw new Error("Garmin account resolved to multiple Dofek owners");
          }
          for (const userId of userIds) {
            try {
              await withAccountErasureUserWriteFence(db, userId, async (transaction) => {
                const tokens = await loadTokens(transaction, "garmin", userId);
                if (!tokens || tokens.providerAccountId !== event.ownerExternalId) return;
                if (!tokens.authorizationId) {
                  throw new Error("Garmin authorization has no grant identifier; reconnect Garmin");
                }
                const { generation } = await readGarminDeliveryState(transaction, userId);
                await enqueueEvent(userId, {
                  ...event,
                  metadata: {
                    ...event.metadata,
                    authorizationId: tokens.authorizationId,
                    providerDataGeneration: generation,
                  },
                });
              });
            } catch (error) {
              if (error instanceof AccountErasureUserFencedError) continue;
              failed = true;
              captureException(error, {
                tags: { provider: "garmin", operation: "webhook-enqueue" },
              });
            }
          }
        }
      } catch (error) {
        failed = true;
        captureException(error, {
          tags: { provider: "garmin", operation: "webhook-owner-lookup" },
        });
      }
      if (failed) {
        res.status(503).json({ error: "Garmin notification could not be queued; retry delivery" });
        return;
      }
      res.status(200).json({ status: "accepted" });
    },
  );

  const bodyErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (typeof error === "object" && error !== null && "type" in error) {
      if (error.type === "entity.too.large") {
        res.status(413).json({ error: "Garmin notification body exceeds 1 MiB" });
        return;
      }
      if (
        error.type === "encoding.unsupported" ||
        error.type === "request.aborted" ||
        error.type === "request.size.invalid"
      ) {
        res.status(400).json({ error: "Invalid Garmin notification body" });
        return;
      }
    }
    captureException(error, { tags: { provider: "garmin", operation: "webhook-body" } });
    res.status(503).json({ error: "Garmin notification could not be received; retry delivery" });
  };
  router.use(bodyErrorHandler);
  return router;
}
