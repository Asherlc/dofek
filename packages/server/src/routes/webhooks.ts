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
 * 6. Returns 200 only after each actionable event is processed or durably queued
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { runWithTokenUser } from "dofek/db/token-user-context";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import { captureException } from "dofek/lib/error-reporting";
import type { WebhookEvent, WebhookProvider } from "dofek/providers/types";
import { sql } from "drizzle-orm";
import { Router, raw } from "express";
import rateLimit from "express-rate-limit";
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

type WebhookFailurePhase =
  | "event-processing"
  | "request-processing"
  | "targeted-sync"
  | "validation-challenge";

function captureWebhookFailure(
  error: unknown,
  providerName: string,
  phase: WebhookFailurePhase,
  event?: WebhookEvent,
): void {
  if (event) {
    captureException(error, {
      tags: {
        provider: providerName,
        webhookEventType: event.eventType,
        webhookObjectType: event.objectType,
        webhookPhase: phase,
      },
    });
    return;
  }

  captureException(error, {
    tags: {
      provider: providerName,
      webhookPhase: phase,
    },
  });
}

async function reconcileExpiredPendingSubscriptions(
  repository: WebhookSubscriptionRepository,
  provider: WebhookProvider,
): Promise<void> {
  for await (const subscription of repository.iterateExpiredPendingByProviderName(provider.id)) {
    if (!subscription.subscriptionExternalId) continue;
    try {
      await provider.unregisterWebhook(subscription.subscriptionExternalId);
      await repository.deletePendingSubscription(subscription.id);
    } catch (error: unknown) {
      captureException(error, {
        tags: { provider: provider.id, webhookPhase: "expired-subscription-reconciliation" },
      });
    }
  }
}

export function createWebhookRouter({ db, syncQueue: _syncQueue }: WebhookRouterDeps): Router {
  const router = Router();
  const webhookSubscriptionRepository = new WebhookSubscriptionRepository(db);

  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      message: "Too many rejected webhook requests — please try again later",
    }),
  );

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
      const { ensureProvidersRegistered } = await import("../routers/sync-helpers.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerName);
      if (!provider || !isWebhookProvider(provider)) {
        logger.warn(`[webhook] GET challenge for unknown/non-webhook provider: ${providerName}`);
        res.status(404).send("Not found");
        return;
      }

      const handleValidationChallenge = provider.handleValidationChallenge;
      if (!handleValidationChallenge) {
        res.status(200).send("OK");
        return;
      }

      const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
      let subscriptionFound = false;
      let response: ReturnType<typeof handleValidationChallenge> = null;
      for await (const subscription of webhookSubscriptionRepository.iterateActiveByProviderName(
        providerName,
      )) {
        subscriptionFound = true;
        response = handleValidationChallenge(query, subscription.verifyToken);
        if (response !== null) {
          break;
        }
      }
      if (response === null) {
        await reconcileExpiredPendingSubscriptions(webhookSubscriptionRepository, provider);
        for await (const subscription of webhookSubscriptionRepository.iteratePendingByProviderName(
          providerName,
        )) {
          subscriptionFound = true;
          response = handleValidationChallenge(query, subscription.verifyToken);
          if (response !== null) break;
        }
      }
      if (!subscriptionFound) {
        logger.warn(`[webhook] No active subscription for ${providerName} challenge`);
        res.status(404).send("No subscription");
        return;
      }

      if (response === null) {
        res.status(400).send("Challenge failed");
        return;
      }

      logger.info(`[webhook] Validated ${providerName} challenge`);
      res.json(response);
    } catch (err) {
      captureWebhookFailure(err, providerName, "validation-challenge");
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
      const { ensureProvidersRegistered } = await import("../routers/sync-helpers.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerName);
      if (!provider || !isWebhookProvider(provider)) {
        logger.warn(`[webhook] POST event for unknown/non-webhook provider: ${providerName}`);
        res.status(404).send("Not found");
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
      let subscriptionFound = false;
      let signatureIsValid: boolean | undefined;
      for await (const subscription of webhookSubscriptionRepository.iterateActiveByProviderName(
        providerName,
      )) {
        subscriptionFound = true;
        signatureIsValid = provider.verifyWebhookSignature(
          rawBody,
          req.headers,
          subscription.signingSecret ?? subscription.verifyToken,
        );
        if (signatureIsValid) {
          break;
        }
      }
      if (!subscriptionFound) {
        logger.warn(`[webhook] No active subscription for ${providerName}`);
        res.status(404).send("No subscription");
        return;
      }

      if (!signatureIsValid) {
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
      // `processed` counts all successfully handled events (targeted or fallback) and is used for log summary.
      let processed = 0;
      let failed = 0;

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
            logger.warn(`[webhook] ${providerName}: no user found for external account`);
            continue;
          }

          const { provider_id, user_id } = row;

          const processingKind = await withAccountErasureUserWriteFence(
            db,
            user_id,
            async (transaction): Promise<"enqueued" | "targeted"> => {
              // If the provider supports targeted webhook sync, use it directly
              // instead of enqueueing a full sync job. This is much more efficient
              // (e.g., 2 API calls for Strava instead of 41, or 0 for Wahoo).
              const syncWebhookEvent = provider.syncWebhookEvent;
              if (syncWebhookEvent) {
                try {
                  const result = await runWithTokenUser(user_id, () =>
                    syncWebhookEvent(transaction, event, { userId: user_id }),
                  );
                  logger.info(
                    `[webhook] ${providerName}: synced ${result.recordsSynced} records for ${event.eventType} ${event.objectType} (${result.duration}ms)`,
                  );
                  return "targeted";
                } catch (err: unknown) {
                  captureWebhookFailure(err, providerName, "targeted-sync", event);
                  logger.warn(
                    `[webhook] ${providerName}: targeted sync failed, falling back to full sync: ${err}`,
                  );
                  // Fall through to enqueue a full sync as fallback
                }
              }

              // Fallback: enqueue a full 1-day sync via BullMQ
              await enqueueSyncJob(provider_id, {
                providerId: provider_id,
                sinceDays: 1,
                userId: user_id,
                origin: "manual",
              });
              return "enqueued";
            },
          );
          processed++;

          if (processingKind === "enqueued") {
            logger.info(
              `[webhook] ${providerName}: enqueued full sync (${event.eventType} ${event.objectType})`,
            );
          }
        } catch (err) {
          if (err instanceof AccountErasureUserFencedError) {
            processed++;
            logger.info(`[webhook] ${providerName}: ignored event for an account being erased`);
            continue;
          }
          failed++;
          captureWebhookFailure(err, providerName, "event-processing", event);
          logger.error(`[webhook] ${providerName}: failed to process event: ${err}`);
        }
      }

      logger.info(
        `[webhook] ${providerName}: received ${events.length} events, ${processed} accepted, ${failed} failed`,
      );

      if (failed > 0) {
        res.status(503).send("Retry later");
        return;
      }

      res.status(200).send("OK");
    } catch (err) {
      captureWebhookFailure(err, providerName, "request-processing");
      logger.error(`[webhook] Error processing ${providerName} event: ${err}`);
      res.status(503).send("Retry later");
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
  db: Pick<import("dofek/db").Database, "execute">,
  provider: WebhookProvider,
  userId: string,
): Promise<void> {
  const webhookSubscriptionRepository = new WebhookSubscriptionRepository(db);
  const publicUrl = process.env.PUBLIC_URL ?? "https://dofek.fit";
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
  const pendingId = randomUUID();
  await webhookSubscriptionRepository.createPendingSubscription(pendingId, {
    userId: provider.webhookScope === "user" ? userId : null,
    providerId: provider.webhookScope === "user" ? provider.id : null,
    providerName: provider.id,
    verifyToken,
    metadata: { callbackUrl },
  });
  let result: Awaited<ReturnType<WebhookProvider["registerWebhook"]>>;
  try {
    result = await provider.registerWebhook(callbackUrl, verifyToken);
  } catch (error: unknown) {
    captureException(error, {
      tags: { provider: provider.id, webhookPhase: "provider-registration" },
    });
    try {
      await webhookSubscriptionRepository.deletePendingSubscription(pendingId);
    } catch (cleanupError: unknown) {
      captureException(cleanupError, {
        tags: { provider: provider.id, webhookPhase: "pending-subscription-cleanup" },
      });
    }
    throw error;
  }
  try {
    await webhookSubscriptionRepository.recordPendingSubscriptionExternalId(
      pendingId,
      result.subscriptionId,
    );
  } catch (error: unknown) {
    captureException(error, {
      tags: { provider: provider.id, webhookPhase: "subscription-id-persistence" },
    });
    try {
      await provider.unregisterWebhook(result.subscriptionId);
    } catch (cleanupError: unknown) {
      captureException(cleanupError, {
        tags: { provider: provider.id, webhookPhase: "registration-compensation" },
      });
      try {
        await webhookSubscriptionRepository.recordPendingSubscriptionExternalId(
          pendingId,
          result.subscriptionId,
        );
      } catch (retryError: unknown) {
        captureException(retryError, {
          tags: { provider: provider.id, webhookPhase: "subscription-id-persistence-retry" },
        });
      }
      throw error;
    }
    try {
      await webhookSubscriptionRepository.deletePendingSubscription(pendingId);
    } catch (cleanupError: unknown) {
      captureException(cleanupError, {
        tags: { provider: provider.id, webhookPhase: "pending-subscription-cleanup" },
      });
    }
    throw error;
  }
  try {
    await webhookSubscriptionRepository.activatePendingSubscription(pendingId, provider.id, {
      signingSecret: result.signingSecret ?? null,
      expiresAt: result.expiresAt ?? null,
      subscriptionExternalId: result.subscriptionId,
    });
  } catch (error: unknown) {
    captureException(error, {
      tags: { provider: provider.id, webhookPhase: "subscription-persistence" },
    });
    try {
      await webhookSubscriptionRepository.deletePendingSubscription(pendingId);
    } catch (cleanupError: unknown) {
      captureException(cleanupError, {
        tags: { provider: provider.id, webhookPhase: "pending-subscription-cleanup" },
      });
    }
    try {
      await provider.unregisterWebhook(result.subscriptionId);
    } catch (cleanupError: unknown) {
      captureException(cleanupError, {
        tags: { provider: provider.id, webhookPhase: "registration-compensation" },
      });
    }
    throw error;
  }
}
