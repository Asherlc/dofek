import { timingSafeEqual } from "node:crypto";
import type { SyncDatabase } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { findTokenUsersByProviderAccountId, loadTokens } from "dofek/db/tokens";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import { captureException } from "dofek/lib/error-reporting";
import type { RequestHandler } from "express";
import { z } from "zod";

const INTERVALS_ICU_PROVIDER_ID = "intervals.icu";

const envelopeSchema = z.object({
  secret: z.string(),
  events: z.array(z.unknown()),
});

const actionableEventSchema = z.object({
  type: z.enum([
    "ACTIVITY_UPLOADED",
    "ACTIVITY_ANALYZED",
    "ACTIVITY_DELETED",
    "CALENDAR_UPDATED",
    "WELLNESS_UPDATED",
  ]),
  athlete_id: z.string().trim().min(1),
  timestamp: z.iso.datetime({ offset: true }),
});

const eventTypeSchema = actionableEventSchema.pick({ type: true });

interface IntervalsIcuWebhookHandlerDeps {
  db: SyncDatabase;
  webhookSecret: string | undefined;
}

function secretsMatch(expected: string, supplied: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const suppliedBuf = Buffer.from(supplied);
  return expectedBuf.length === suppliedBuf.length && timingSafeEqual(expectedBuf, suppliedBuf);
}

/** Authenticated Intervals.icu webhook handler; expects the shared raw 1 MiB body parser. */
export function createIntervalsIcuWebhookHandler({
  db,
  webhookSecret,
}: IntervalsIcuWebhookHandlerDeps): RequestHandler {
  return async (req, res) => {
    if (webhookSecret === undefined || webhookSecret.trim() === "") {
      res.status(503).send("INTERVALS_ICU_WEBHOOK_SECRET is not configured");
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      res.status(400).send("Expected a JSON request body");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      res.status(400).send("Invalid JSON");
      return;
    }

    const envelope = envelopeSchema.safeParse(payload);
    if (!envelope.success) {
      res.status(400).send("Invalid payload");
      return;
    }

    if (!secretsMatch(webhookSecret, envelope.data.secret)) {
      res.status(401).send("Unauthorized");
      return;
    }

    const byAthlete = new Map<string, number>();
    for (const rawEvent of envelope.data.events) {
      if (!eventTypeSchema.safeParse(rawEvent).success) {
        continue;
      }
      const parsed = actionableEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        res.status(400).send("Invalid payload");
        return;
      }
      const athleteId = parsed.data.athlete_id;
      const current = Date.parse(parsed.data.timestamp);
      const latest = byAthlete.get(athleteId);
      byAthlete.set(athleteId, Math.max(latest ?? current, current));
    }

    let failed = false;
    for (const [athleteId, requestedAt] of byAthlete) {
      try {
        const userIds = await findTokenUsersByProviderAccountId(
          db,
          INTERVALS_ICU_PROVIDER_ID,
          athleteId,
        );
        if (userIds.length > 1) {
          throw new Error("Intervals.icu athlete resolved to multiple Dofek owners");
        }
        const userId = userIds[0];
        if (!userId) {
          continue;
        }

        await withAccountErasureUserWriteFence(db, userId, async (transaction) => {
          const tokens = await loadTokens(transaction, INTERVALS_ICU_PROVIDER_ID, userId);
          if (tokens?.providerAccountId !== athleteId) {
            return;
          }
          await enqueueSyncJob(INTERVALS_ICU_PROVIDER_ID, {
            providerId: INTERVALS_ICU_PROVIDER_ID,
            userId,
            sinceDays: 1,
            origin: "manual",
            requestedAtIso: new Date(requestedAt).toISOString(),
          });
        });
      } catch (error) {
        if (error instanceof AccountErasureUserFencedError) {
          continue;
        }
        failed = true;
        captureException(error, {
          tags: {
            provider: INTERVALS_ICU_PROVIDER_ID,
            operation: "webhook-dispatch",
          },
        });
      }
    }

    if (failed) {
      res.status(503).send("Retry later");
      return;
    }
    res.status(200).send("OK");
  };
}
