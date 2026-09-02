import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import { accountErasureQueuedUserWorkLockName } from "../db/account-erasure-locks.ts";
import { isAccountErasureActive } from "../db/account-erasure-processing.ts";
import type { Database } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { logger } from "../logger.ts";

const ACCOUNT_ERASURE_WORK_LOCK_POOL_SIZE = 4;
const advisoryUnlockRowSchema = z.object({ unlocked: z.boolean() });

class AsyncPermitPool {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  constructor(size: number) {
    this.#available = size;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return () => this.#release();
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#available += 1;
  }
}

type WorkOutcome<T> =
  | {
      status: "completed";
      value: T;
    }
  | {
      error: unknown;
      status: "failed";
    };

export interface AccountErasureWorkLockPool {
  close(): Promise<void>;
  runWithSharedUserLock<T>(userId: string, work: () => Promise<T>): Promise<T>;
}

class PostgresAccountErasureWorkLockPool implements AccountErasureWorkLockPool {
  readonly #pool: Pool;
  readonly #connectionPermits = new AsyncPermitPool(ACCOUNT_ERASURE_WORK_LOCK_POOL_SIZE);

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async runWithSharedUserLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const releaseConnectionPermit = await this.#connectionPermits.acquire();
    try {
      const client = await this.#pool.connect();
      const database = drizzle(client);
      try {
        await executeWithSchema(
          database,
          z.object({}),
          sql`SELECT pg_advisory_lock_shared(
                hashtextextended(${accountErasureQueuedUserWorkLockName(userId)}::text, 0)
              )`,
        );
      } catch (error: unknown) {
        client.release(true);
        Sentry.captureException(error, {
          tags: {
            accountErasureWorkLockStep: "acquire",
            source: "account-erasure-work-lock",
          },
        });
        throw error;
      }

      const outcome: WorkOutcome<T> = await Promise.resolve()
        .then(work)
        .then(
          (value): WorkOutcome<T> => ({ status: "completed", value }),
          (error: unknown): WorkOutcome<T> => ({ error, status: "failed" }),
        );

      try {
        const unlockRows = await executeWithSchema(
          database,
          advisoryUnlockRowSchema,
          sql`SELECT pg_advisory_unlock_shared(
                hashtextextended(${accountErasureQueuedUserWorkLockName(userId)}::text, 0)
              ) AS unlocked`,
        );
        const unlockRow = unlockRows[0];
        if (!unlockRow?.unlocked) {
          throw new Error("Queued user work advisory lock was not held by its PostgreSQL session");
        }
      } catch (error: unknown) {
        client.release(true);
        Sentry.captureException(error, {
          tags: {
            accountErasureWorkLockStep: "release",
            source: "account-erasure-work-lock",
          },
        });
        if (outcome.status === "failed") {
          throw outcome.error;
        }
        throw error;
      }
      client.release();

      if (outcome.status === "failed") {
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      releaseConnectionPermit();
    }
  }
}

export function createAccountErasureWorkLockPool(
  connectionString: string,
): AccountErasureWorkLockPool {
  const pool = new Pool({
    application_name: "dofek-account-erasure-work-lock",
    connectionString,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 300_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 60_000,
    max: ACCOUNT_ERASURE_WORK_LOCK_POOL_SIZE,
  });
  pool.on("error", (error) => {
    Sentry.captureException(error, {
      tags: { source: "account-erasure-work-lock-pool" },
    });
    logger.error(`[account-erasure-work-lock] PostgreSQL pool idle client error: ${error.message}`);
  });
  return new PostgresAccountErasureWorkLockPool(pool);
}

export function createAccountErasureWorkLockPoolFromEnv(): AccountErasureWorkLockPool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return createAccountErasureWorkLockPool(connectionString);
}

export async function accountErasureAllowsQueuedUserWork(
  database: Pick<Database, "execute">,
  userId: string,
  workKind: string,
): Promise<boolean> {
  if (!(await isAccountErasureActive(database, userId))) {
    return true;
  }
  logger.info(`[worker] Discarding ${workKind} because account erasure is active`);
  return false;
}

export async function runQueuedUserWorkUnlessAccountErasing<T>(
  workLockPool: AccountErasureWorkLockPool,
  database: Pick<Database, "execute">,
  userId: string,
  workKind: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  return workLockPool.runWithSharedUserLock(userId, async () => {
    if (!(await accountErasureAllowsQueuedUserWork(database, userId, workKind))) {
      return undefined;
    }
    return work();
  });
}
