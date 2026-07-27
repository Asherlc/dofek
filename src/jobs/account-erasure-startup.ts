import * as Sentry from "@sentry/node";

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
