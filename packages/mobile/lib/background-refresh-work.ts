import { captureException } from "./telemetry";

export interface RequiredBackgroundRefreshOperation {
  run: () => Promise<void>;
  source: string;
}

/**
 * Runs every required refresh operation to settlement, reports each failure,
 * and rejects only after the remaining operations have had a chance to finish.
 */
export async function runRequiredBackgroundRefreshWork(
  operations: readonly RequiredBackgroundRefreshOperation[],
): Promise<void> {
  const results = await Promise.allSettled(
    operations.map(({ run }) => Promise.resolve().then(run)),
  );
  const failures: unknown[] = [];

  for (const [index, result] of results.entries()) {
    const operation = operations[index];
    if (result.status === "rejected" && operation) {
      captureException(result.reason, { source: operation.source });
      failures.push(result.reason);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Background refresh failed");
  }
}
