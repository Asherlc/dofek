/**
 * Webhook receiver router.
 *
 * Handles incoming webhook events from data providers (Strava, Fitbit, Oura, etc.).
 * Each provider POSTs events to /api/webhooks/:providerName when data changes.
 *
 * Flow:
 * 1. Provider sends POST (or GET for validation challenges)
 * 2. Router looks up the provider and verifies the webhook signature
 * 3. Parses the payload into WebhookEvents
 * 4. Resolves the external owner ID → internal user + provider row
 * 5. Enqueues a targeted BullMQ sync job for that user+provider
 * 6. Returns 200 immediately (providers expect fast responses)
 */

import type { WebhookEvent } from "dofek/providers/types";
import { sql } from "drizzle-orm";
import { Router, raw } from "express";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

const webhookSubscriptionRow = z.object({
  id: z.string(),
  provider_id: z.string().nullable(),
  verify_token: z.string(),
  signing_secret: z.string().nullable(),
});

const providerUserRow = z.object({
  provider_id: z.string(),
  user_id: z.string(),
});

interface WebhookRouterDeps {
  db: import("dofek/db").Database;
  getSyncQueue: () => import("bullmq").Queue;
}

export function createWebhookRouter({ db, getSyncQueue }: WebhookRouterDeps): Router {
  const router = Router();

  // Use raw body parser for all webhook routes — needed for HMAC signature verification.
  // Must come before any json() middleware.
  router.use(raw({ type: "*/*", limit: "1mb" }));

  /**
   * GET /api/webhooks/:providerName
   * Handles validation challenges (Strava hub.challenge, Fitbit verification, etc.)
   */
  router.get("/:providerName", async (req, res) => {
    const { providerName } = req.params;

    try {
      const { getAllProviders } = await import("dofek/providers/registry");
      const { isWebhookProvider } = await import("dofek/providers/types");
      const { ensureProvidersRegistered } = await import("../routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerName);
      if (!provider || !isWebhookProvider(provider)) {
        logger.warn(`[webhook] GET challenge for unknown/non-webhook provider: ${providerName}`);
        res.status(404).send("Not found");
        return;
      }

      if (!provider.handleValidationChallenge) {
        res.status(200).send("OK");
        return;
      }

      // Look up stored verify token
      const subscriptions = await executeWithSchema(
        db,
        webhookSubscriptionRow,
        sql`SELECT id, provider_id, verify_token, signing_secret
            FROM fitness.webhook_subscription
            WHERE provider_name = ${providerName} AND status = 'active'
            LIMIT 1`,
      );
      const sub = subscriptions[0];
      if (!sub) {
        logger.warn(`[webhook] No active subscription for ${providerName} challenge`);
        res.status(404).send("No subscription");
        return;
      }

      const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
      const response = provider.handleValidationChallenge(query, sub.verify_token);

      if (response === null) {
        res.status(400).send("Challenge failed");
        return;
      }

      logger.info(`[webhook] Validated ${providerName} challenge`);
      res.json(response);
    } catch (err) {
      logger.error(`[webhook] Challenge error for ${providerName}: ${err}`);
      res.status(500).send("Internal error");
    }
  });

  /**
   * POST /api/webhooks/:providerName
   * Receives webhook events, verifies signature, and enqueues sync jobs.
   */
  router.post("/:providerName", async (req, res) => {
    const { providerName } = req.params;

    try {
      const { getAllProviders } = await import("dofek/providers/registry");
      const { isWebhookProvider } = await import("dofek/providers/types");
      const { ensureProvidersRegistered } = await import("../routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerName);
      if (!provider || !isWebhookProvider(provider)) {
        logger.warn(`[webhook] POST event for unknown/non-webhook provider: ${providerName}`);
        res.status(404).send("Not found");
        return;
      }

      // Look up subscription for signature verification
      const subscriptions = await executeWithSchema(
        db,
        webhookSubscriptionRow,
        sql`SELECT id, provider_id, verify_token, signing_secret
            FROM fitness.webhook_subscription
            WHERE provider_name = ${providerName} AND status = 'active'
            LIMIT 1`,
      );
      const sub = subscriptions[0];
      if (!sub) {
        logger.warn(`[webhook] No active subscription for ${providerName}`);
        res.status(404).send("No subscription");
        return;
      }

      // Verify signature if provider has a signing secret
      const signingSecret = sub.signing_secret ?? sub.verify_token;
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));

      if (!provider.verifyWebhookSignature(rawBody, req.headers, signingSecret)) {
        logger.warn(`[webhook] Invalid signature for ${providerName}`);
        res.status(401).send("Invalid signature");
        return;
      }

      // Parse the body (raw → JSON)
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf-8"));
      } catch {
        logger.warn(`[webhook] Invalid JSON from ${providerName}`);
        res.status(400).send("Invalid JSON");
        return;
      }

      // Extract events
      let events: WebhookEvent[];
      try {
        events = provider.parseWebhookPayload(payload);
      } catch (err) {
        logger.error(`[webhook] Failed to parse ${providerName} payload: ${err}`);
        res.status(400).send("Invalid payload");
        return;
      }

      if (events.length === 0) {
        logger.info(`[webhook] ${providerName}: no actionable events`);
        res.status(200).send("OK");
        return;
      }

      // Resolve external owner IDs → internal user+provider and enqueue syncs
      const queue = getSyncQueue();
      let enqueued = 0;

      for (const event of events) {
        try {
          // Find the internal provider row + user for this external account ID.
          // Join through auth_account (identity-linked providers) or look up directly.
          const rows = await executeWithSchema(
            db,
            providerUserRow,
            sql`SELECT p.id AS provider_id, p.user_id
                FROM fitness.provider p
                JOIN fitness.auth_account aa ON aa.user_id = p.user_id
                WHERE aa.auth_provider = ${providerName}
                  AND aa.provider_account_id = ${event.ownerExternalId}
                  AND p.name = ${provider.name}
                LIMIT 1`,
          );

          const row = rows[0];
          if (!row) {
            logger.warn(
              `[webhook] ${providerName}: no user found for external ID ${event.ownerExternalId}`,
            );
            continue;
          }

          const { provider_id, user_id } = row;

          await queue.add("sync", {
            providerId: provider_id,
            sinceDays: 1,
            userId: user_id,
          });
          enqueued++;

          logger.info(
            `[webhook] ${providerName}: enqueued sync for user ${user_id} (${event.eventType} ${event.objectType})`,
          );
        } catch (err) {
          logger.error(
            `[webhook] ${providerName}: failed to process event for ${event.ownerExternalId}: ${err}`,
          );
        }
      }

      // Spin up the worker container if needed
      if (enqueued > 0) {
        try {
          const { startWorker } = await import("../lib/start-worker.ts");
          await startWorker();
        } catch (err) {
          logger.warn(`[webhook] Failed to start worker: ${err}`);
        }
      }

      logger.info(
        `[webhook] ${providerName}: processed ${events.length} events, enqueued ${enqueued} syncs`,
      );
      res.status(200).send("OK");
    } catch (err) {
      logger.error(`[webhook] Error processing ${providerName} event: ${err}`);
      // Still return 200 to prevent retries that could cause loops
      res.status(200).send("OK");
    }
  });

  return router;
}
