import {
  type AccountErasureWorkLockPool,
  createAccountErasureWorkLockPoolFromEnv,
} from "../jobs/account-erasure-work-guard.ts";
import { AccountErasureUserFencedError } from "./account-erasure.ts";
import { isAccountErasureActive } from "./account-erasure-processing.ts";
import type { Database } from "./index.ts";

let providerOperationLockPool: AccountErasureWorkLockPool | undefined;
function getProviderOperationLockPool(): AccountErasureWorkLockPool {
  providerOperationLockPool ??= createAccountErasureWorkLockPoolFromEnv();
  return providerOperationLockPool;
}

export async function closeProviderOperationFencePool(): Promise<void> {
  const pool = providerOperationLockPool;
  providerOperationLockPool = undefined;
  await pool?.close();
}

export async function withProviderOperationFence<T>(
  database: Database,
  userId: string,
  providerId: string,
  operation: (database: Database) => Promise<T>,
  workLockPool: AccountErasureWorkLockPool = getProviderOperationLockPool(),
): Promise<T> {
  // Lock waiters use the dedicated bounded pool, leaving work connections free
  // for a rotated credential to commit before a later remote revocation fails.
  return workLockPool.runWithSharedUserLock(
    userId,
    async () => {
      if (await isAccountErasureActive(database, userId)) throw new AccountErasureUserFencedError();
      return operation(database);
    },
    providerId,
  );
}
