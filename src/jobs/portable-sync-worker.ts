import { createServer } from "node:http";
import { createDatabaseFromEnv } from "../db/index.ts";
import { startInstrumentation } from "../instrumentation.ts";
import { initProductionSentry } from "../lib/sentry.ts";
import { logger } from "../logger.ts";
import { getEnabledSyncProviders } from "../providers/index.ts";
import { prepareProviderWorker } from "./account-erasure-startup.ts";
import { createAccountErasureWorkLockPoolFromEnv } from "./account-erasure-work-guard.ts";
import { runPortableSyncQueues } from "./portable-sync-queues.ts";
import { createPortableSyncSlot } from "./portable-sync-slot.ts";
import { getConfiguredProviderIds, getProviderQueueConfig } from "./provider-queue-config.ts";
import { createProviderSyncProcessor } from "./provider-sync-processor.ts";
import { closeAllQueueResources, getRedisConnection, getSharedRedisConnection } from "./queues.ts";

function eligibleProviderIds(allowed: string[]): string[] {
  const configuredQueues = new Set(getConfiguredProviderIds());
  const enabled = new Set(getEnabledSyncProviders().map(({ id }) => id));
  const unsupported = allowed.filter((id) => !configuredQueues.has(id) || !enabled.has(id));
  if (unsupported.length) {
    throw new Error(`SYNC_WORKER_PROVIDERS includes unavailable queues: ${unsupported.join(", ")}`);
  }
  const limited = allowed.filter((id) => getProviderQueueConfig(id).limiter !== undefined);
  if (limited.length) {
    throw new Error(`SYNC_WORKER_PROVIDERS includes rate-limited queues: ${limited.join(", ")}`);
  }
  return allowed;
}

const allowed = Array.from(
  new Set(
    process.env.SYNC_WORKER_PROVIDERS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),
);
if (allowed.length === 0) throw new Error("SYNC_WORKER_PROVIDERS is required");
if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");

const sdk = startInstrumentation(process.env, { shutdownOnSignal: false, exportPostHog: false });
initProductionSentry(process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted);
const db = createDatabaseFromEnv();
const workLockPool = createAccountErasureWorkLockPoolFromEnv();
const shutdown = new AbortController();
const readiness = createServer((_request, response) => {
  response.writeHead(shutdown.signal.aborted ? 503 : 200).end();
});
const stop = () => {
  readiness.close();
  shutdown.abort();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  await prepareProviderWorker(db);
  const providerIds = eligibleProviderIds(allowed);
  logger.info(`[portable-sync-worker] Eligible queues: ${providerIds.join(", ")}`);
  await runPortableSyncQueues({
    providerIds,
    connection: getRedisConnection(),
    processor: createProviderSyncProcessor(db, workLockPool),
    signal: shutdown.signal,
    slot: createPortableSyncSlot(await getSharedRedisConnection().client),
    onReady: () => readiness.listen(3002, "::"),
  });
} finally {
  readiness.close();
  try {
    await Promise.all([closeAllQueueResources(), workLockPool.close(), db.$client.end()]);
  } finally {
    await sdk?.shutdown();
  }
}
