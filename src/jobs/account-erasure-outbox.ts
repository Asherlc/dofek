import * as Sentry from "@sentry/node";
import {
  deleteExpiredAccountErasurePreparations,
  listPendingAccountErasureRequests,
  markAccountErasureDispatched,
  markOverdueAccountErasureRequests,
} from "../db/account-erasure-processing.ts";
import type { Database } from "../db/index.ts";
import { logger } from "../logger.ts";
import { type AccountErasureQueue, enqueueAccountErasure } from "./queues.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function dispatchAccountErasureOutbox(
  database: Pick<Database, "execute">,
  queue: AccountErasureQueue,
  limit = DEFAULT_BATCH_SIZE,
): Promise<number> {
  await deleteExpiredAccountErasurePreparations(database, limit);
  const overdueCount = await markOverdueAccountErasureRequests(database);
  if (overdueCount > 0) {
    const message = `${overdueCount} account erasure request(s) exceeded the 30-day deadline`;
    Sentry.captureMessage(message, {
      level: "error",
      tags: { source: "account-erasure-outbox" },
    });
    logger.error(`[account-erasure-outbox] ${message}`);
  }
  const requests = await listPendingAccountErasureRequests(database, limit);
  for (const request of requests) {
    await enqueueAccountErasure(request, queue);
    await markAccountErasureDispatched(database, request.id);
  }
  return requests.length;
}

export interface AccountErasureOutboxDispatcher {
  close(): Promise<void>;
}

export function startAccountErasureOutboxDispatcher(
  database: Pick<Database, "execute">,
  queue: AccountErasureQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): AccountErasureOutboxDispatcher {
  let closed = false;
  let dispatchPromise: Promise<void> | null = null;

  const dispatch = (): void => {
    if (closed || dispatchPromise) return;
    dispatchPromise = dispatchAccountErasureOutbox(database, queue)
      .then((count) => {
        if (count > 0) {
          logger.info(`[account-erasure-outbox] Dispatched ${count} request(s)`);
        }
      })
      .catch((error: unknown) => {
        Sentry.captureException(new Error("Account erasure outbox dispatch failed"), {
          tags: {
            errorName: errorName(error),
            source: "account-erasure-outbox",
          },
        });
        logger.error("[account-erasure-outbox] Dispatch failed");
      })
      .finally(() => {
        dispatchPromise = null;
      });
  };

  dispatch();
  const timer = setInterval(dispatch, pollIntervalMs);

  return {
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await dispatchPromise;
    },
  };
}
