import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { Router, raw } from "express";
import { ZodError, z } from "zod";
import { verifyAppStoreNotification } from "../billing/app-store-verifier.ts";
import { applyAppStoreNotification } from "../repositories/billing-repository.ts";

const appStoreWebhookBodySchema = z.object({ signedPayload: z.string().min(1) }).strict();

interface AppStoreWebhookRouterDeps {
  db: Pick<Database, "transaction">;
}

function parseWebhookBody(body: unknown): z.infer<typeof appStoreWebhookBodySchema> {
  if (!Buffer.isBuffer(body)) {
    throw new SyntaxError("App Store webhook body must be JSON");
  }
  const parsedBody: unknown = JSON.parse(body.toString("utf8"));
  return appStoreWebhookBodySchema.parse(parsedBody);
}

function isInvalidWebhook(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof ZodError ||
    (error instanceof TRPCError && error.code === "PRECONDITION_FAILED")
  );
}

export function createAppStoreWebhookRouter({ db }: AppStoreWebhookRouterDeps): Router {
  const router = Router();

  router.post("/", raw({ type: "application/json", limit: "1mb" }), async (req, res, next) => {
    try {
      const { signedPayload } = parseWebhookBody(req.body);
      const notification = await verifyAppStoreNotification(signedPayload);

      const updatedUserIds = await applyAppStoreNotification(db, notification);

      await Promise.all(updatedUserIds.map((userId) => invalidateAllUserQueries(userId)));
      res.status(200).json({ received: true });
    } catch (error) {
      if (isInvalidWebhook(error)) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid payload" });
        return;
      }
      next(error);
    }
  });

  return router;
}
