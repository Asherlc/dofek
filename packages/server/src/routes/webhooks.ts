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

import { randomBytes } from "node:crypto";
import { runWithTokenUser } from "dofek/db/token-user-context";
import type { WebhookEvent, WebhookProvider } from "dofek/providers/types";
import { sql } from "drizzle-orm";
import { Router, raw } from "express";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { WebhookSubscriptionRepository } from "../repositories/webhook-subscription-repository.ts";

const providerUserRow = z.object({
  provider_id: z.string(),
  user_id: z.string(),
});

interface WebhookRouterDeps {
  db: import("dofek/db").Database;
  syncQueue: import("bullmq").Queue;
}

export function createWebhookRouter({ db, syncQueue }: WebhookRouterDeps): Router {
  const router = Router();
  const webhookSubscriptionRepository = new WebhookSubscriptionRepository(db);

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

      const sub = await webhookSubscriptionRepository.getActiveByProviderName(providerName);
      if (!sub) {
        logger.warn(`[webhook] No active subscription for ${providerName} challenge`);
        res.status(404).send("No subscription");
        return;
      }

      const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
      const response = provider.handleValidationChallenge(query, sub.verifyToken);

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

      const sub = await webhookSubscriptionRepository.getActiveByProviderName(providerName);
      if (!sub) {
        logger.warn(`[webhook] No active subscription for ${providerName}`);
        res.status(404).send("No subscription");
        return;
      }

      // Verify signature if provider has a signing secret
      const signingSecret = sub.signingSecret ?? sub.verifyToken;
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

      // Resolve external owner IDs → internal user+provider and process events
      const queue = syncQueue;
      // `processed` counts all successfully handled events (targeted or fallback) and is used for log summary.
      // `fallbackJobsEnqueued` counts only events that fell back to full BullMQ sync,
      // which determines whether the worker container needs to be started.
      let processed = 0;
      let fallbackJobsEnqueued = 0;

      for (const event of events) {
        try {
          // Find the internal provider row + user for this external account ID.
          // Join through auth_account (identity-linked providers) or look up directly.
          const rows = await executeWithSchema(
            db,
            providerUserRow,
            sql`SELECT ot.provider_id, ot.user_id
                FROM fitness.oauth_token ot
                JOIN fitness.auth_account aa ON aa.user_id = ot.user_id
                WHERE aa.auth_provider = ${providerName}
                  AND aa.provider_account_id = ${event.ownerExternalId}
                  AND ot.provider_id = ${provider.id}
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

          // If the provider supports targeted webhook sync, use it directly
          // instead of enqueueing a full sync job. This is much more efficient
          // (e.g., 2 API calls for Strava instead of 41, or 0 for Wahoo).
          const syncWebhookEvent = provider.syncWebhookEvent;
          if (syncWebhookEvent) {
            try {
              const result = await runWithTokenUser(user_id, () =>
                syncWebhookEvent(db, event, { userId: user_id }),
              );
              logger.info(
                `[webhook] ${providerName}: synced ${result.recordsSynced} records for ${event.eventType} ${event.objectType} (${result.duration}ms)`,
              );
              processed++;
              continue;
            } catch (err) {
              logger.warn(
                `[webhook] ${providerName}: targeted sync failed, falling back to full sync: ${err}`,
              );
              // Fall through to enqueue a full sync as fallback
            }
          }

          // Fallback: enqueue a full 1-day sync via BullMQ
          await queue.add("sync", {
            providerId: provider_id,
            sinceDays: 1,
            userId: user_id,
          });
          processed++;
          fallbackJobsEnqueued++;

          logger.info(
            `[webhook] ${providerName}: enqueued full sync for user ${user_id} (${event.eventType} ${event.objectType})`,
          );
        } catch (err) {
          logger.error(
            `[webhook] ${providerName}: failed to process event for ${event.ownerExternalId}: ${err}`,
          );
        }
      }

      // Spin up the worker container if fallback sync jobs were enqueued
      if (fallbackJobsEnqueued > 0) {
        try {
          const { startWorker } = await import("../lib/start-worker.ts");
          await startWorker();
        } catch (err) {
          logger.warn(`[webhook] Failed to start worker: ${err}`);
        }
      }

      logger.info(
        `[webhook] ${providerName}: processed ${events.length} events, ${processed} synced`,
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

/**
 * Register a webhook subscription for a provider after OAuth connection.
 * For app-level webhooks (Strava, Fitbit): checks if subscription already exists, skips if so.
 * For per-user webhooks (Withings): creates a subscription per provider connection.
 */
export async function registerWebhookForProvider(
  db: import("dofek/db").Database,
  provider: WebhookProvider,
): Promise<void> {
  const webhookSubscriptionRepository = new WebhookSubscriptionRepository(db);
  const publicUrl = process.env.PUBLIC_URL ?? "https://dofek.asherlc.com";
  const callbackUrl = `${publicUrl}/api/webhooks/${provider.id}`;

  // For app-level webhooks, check if we already have an active subscription
  if (provider.webhookScope === "app") {
    const hasExistingSubscription = await webhookSubscriptionRepository.hasActiveByProviderName(
      provider.id,
    );
    if (hasExistingSubscription) {
      logger.info(`[webhook] ${provider.id}: app-level subscription already exists, skipping`);
      return;
    }
  }

  const verifyToken = randomBytes(32).toString("hex");
  const result = await provider.registerWebhook(callbackUrl, verifyToken);
  await webhookSubscriptionRepository.upsertActiveSubscription({
    providerName: provider.id,
    subscriptionExternalId: result.subscriptionId,
    verifyToken,
    signingSecret: result.signingSecret ?? null,
    expiresAt: result.expiresAt ?? null,
    metadata: { callbackUrl },
  });
}
