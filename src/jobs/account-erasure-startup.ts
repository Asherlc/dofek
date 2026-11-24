import * as Sentry from "@sentry/node";
import { validateAccountErasureLedgerKeyring } from "../account-erasure/identity.ts";
import { createEncryptedAccountErasureSnapshot } from "../account-erasure/remote-snapshot.ts";
import { createAccountErasureRestoreLedgerFromEnv } from "../account-erasure/restore-ledger.ts";
import { reconcileAccountErasureRestoreIntents } from "../account-erasure/restore-reconciliation.ts";
import type { Database } from "../db/index.ts";
import { getAllProviders } from "../providers/index.ts";
import { ensureProvidersRegistered } from "./provider-registration.ts";

export async function runAccountErasureRestoreStartupGate<T>(
  reconcile: () => Promise<T>,
): Promise<T> {
  try {
    return await reconcile();
  } catch (error: unknown) {
    Sentry.captureException(error, {
      tags: { workerStartupStep: "accountErasureRestoreReconciliation" },
    });
    throw error;
  }
}

export async function prepareProviderWorker(
  database: Pick<Database, "execute" | "transaction">,
): Promise<void> {
  validateAccountErasureLedgerKeyring();
  const ledger = createAccountErasureRestoreLedgerFromEnv();
  await ensureProvidersRegistered();
  await runAccountErasureRestoreStartupGate(() =>
    reconcileAccountErasureRestoreIntents({
      createEncryptedRemoteSnapshot: (transaction, userId) =>
        createEncryptedAccountErasureSnapshot(transaction, userId, getAllProviders()),
      database,
      ledger,
    }),
  );
}
