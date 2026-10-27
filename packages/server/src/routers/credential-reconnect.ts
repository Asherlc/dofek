import { TRPCError } from "@trpc/server";
import type { TransactionDatabase } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { ensureProvider } from "dofek/db/tokens";
import { enqueueReconnectSyncJob } from "dofek/jobs/enqueue-sync-job";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import type { AuthenticatedContext } from "../trpc.ts";

export async function completeCredentialReconnect(
  ctx: Pick<AuthenticatedContext, "db" | "userId">,
  provider: { id: string; name: string; apiBaseUrl?: string },
  persistTokens: (transaction: TransactionDatabase) => Promise<void>,
): Promise<void> {
  await withAccountErasureUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
    await ensureProvider(transaction, provider.id, provider.name, provider.apiBaseUrl, ctx.userId);
    await persistTokens(transaction);
  });

  let syncStarted = false;
  try {
    // Commit credentials before dispatch so a worker can read the renewed tokens.
    // Recheck erasure under its lock: it may have started after the first transaction.
    await withAccountErasureUserWriteFence(ctx.db, ctx.userId, async () => {
      await enqueueReconnectSyncJob(provider.id, ctx.userId);
    });
    syncStarted = true;
    await queryCache.invalidateByPrefix(`${ctx.userId}:sync.providers`);
  } catch (error) {
    captureException(error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: syncStarted
        ? `${provider.name} connected and sync started, but its status could not be refreshed. Refresh this page.`
        : `${provider.name} connected, but its sync could not be started. Try Sync again.`,
      cause: error,
    });
  }
}
