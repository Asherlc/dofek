import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getAccessWindowForUser } from "../packages/server/src/billing/access-window-repository.ts";
import type { AccessWindow } from "../packages/server/src/billing/entitlement.ts";
import { ClickHouseActivitySensorStore } from "../packages/server/src/repositories/clickhouse-activity-sensor-store.ts";
import { appRouter } from "../packages/server/src/router.ts";
import type { Context } from "../packages/server/src/trpc.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import { RedisQueryCacheRegistry } from "../src/lib/redis-query-cache-registry.ts";
import { logger } from "../src/logger.ts";
import { recordCacheRunForPendingProcessing } from "../src/processing/cache-processing.ts";

export interface RegisteredQueryCacheKey {
  key: string;
  userId: string;
  path: string;
  timezone: string;
  input: unknown;
}

interface QueryCacheRegistry {
  listKeys(prefix?: string): Promise<string[]>;
}

interface WarmCallerContext<TDatabase, TSensorStore> {
  db: TDatabase;
  sensorStore: TSensorStore;
  userId: string;
  timezone: string;
  accessWindow: AccessWindow;
  cacheMode: "refresh";
}

export interface WarmRegisteredQueryCachesInput<TDatabase, TSensorStore> {
  cacheStore: QueryCacheRegistry;
  db: TDatabase;
  sensorStore: TSensorStore;
  createCaller(context: WarmCallerContext<TDatabase, TSensorStore>): unknown;
  getAccessWindow(db: TDatabase, userId: string): Promise<AccessWindow>;
}

export interface CacheWarmOutcome {
  userId: string;
  path: string;
  status: "succeeded" | "failed";
  errorMessage: string | null;
}

function parseInput(serializedInput: string): unknown {
  if (serializedInput === "undefined") return undefined;
  return JSON.parse(serializedInput);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function parseRegisteredQueryCacheKey(key: string): RegisteredQueryCacheKey | null {
  const userSeparator = key.indexOf(":");
  const pathSeparator = key.indexOf(":", userSeparator + 1);
  const timezoneSeparator = key.indexOf(":", pathSeparator + 1);
  if (userSeparator <= 0 || pathSeparator <= userSeparator || timezoneSeparator <= pathSeparator) {
    return null;
  }

  const userId = key.slice(0, userSeparator);
  const path = key.slice(userSeparator + 1, pathSeparator);
  const timezone = key.slice(pathSeparator + 1, timezoneSeparator);
  if (userId === "anon" || path.length === 0 || !isValidTimezone(timezone)) return null;

  try {
    return {
      key,
      userId,
      path,
      timezone,
      input: parseInput(key.slice(timezoneSeparator + 1)),
    };
  } catch (error) {
    captureException(error, { tags: { cacheOperation: "parseWarmKey" } });
    return null;
  }
}

async function invokeCallerProcedure(caller: unknown, path: string, input: unknown): Promise<void> {
  let procedure: unknown = caller;
  let parent: unknown;
  for (const pathSegment of path.split(".")) {
    if ((typeof procedure !== "object" || procedure === null) && typeof procedure !== "function") {
      throw new Error(`Cached tRPC procedure path is not callable: ${path}`);
    }
    parent = procedure;
    procedure = Reflect.get(parent, pathSegment);
  }
  if (typeof procedure !== "function") {
    throw new Error(`Cached tRPC procedure path is not callable: ${path}`);
  }
  await Reflect.apply(procedure, parent, [input]);
}

export async function warmRegisteredQueryCaches<TDatabase, TSensorStore>(
  input: WarmRegisteredQueryCachesInput<TDatabase, TSensorStore>,
): Promise<{ refreshed: number; failed: number; skipped: number }> {
  const result = await warmRegisteredQueryCachesWithOutcomes(input);
  return { refreshed: result.refreshed, failed: result.failed, skipped: result.skipped };
}

export async function warmRegisteredQueryCachesWithOutcomes<TDatabase, TSensorStore>(
  input: WarmRegisteredQueryCachesInput<TDatabase, TSensorStore>,
  options: { failOnError?: boolean } = {},
): Promise<{
  refreshed: number;
  failed: number;
  skipped: number;
  outcomes: CacheWarmOutcome[];
}> {
  const keys = await input.cacheStore.listKeys();
  const accessWindows = new Map<string, AccessWindow>();
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ path: string; message: string }> = [];
  const outcomes: CacheWarmOutcome[] = [];

  for (const key of keys.sort()) {
    const registeredQuery = parseRegisteredQueryCacheKey(key);
    if (!registeredQuery) {
      skipped += 1;
      continue;
    }

    try {
      let accessWindow = accessWindows.get(registeredQuery.userId);
      if (!accessWindow) {
        accessWindow = await input.getAccessWindow(input.db, registeredQuery.userId);
        accessWindows.set(registeredQuery.userId, accessWindow);
      }
      const caller = input.createCaller({
        db: input.db,
        sensorStore: input.sensorStore,
        userId: registeredQuery.userId,
        timezone: registeredQuery.timezone,
        accessWindow,
        cacheMode: "refresh",
      });
      await invokeCallerProcedure(caller, registeredQuery.path, registeredQuery.input);
      refreshed += 1;
      outcomes.push({
        userId: registeredQuery.userId,
        path: registeredQuery.path,
        status: "succeeded",
        errorMessage: null,
      });
    } catch (error) {
      failed += 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      failures.push({
        path: registeredQuery.path,
        message: errorMessage,
      });
      outcomes.push({
        userId: registeredQuery.userId,
        path: registeredQuery.path,
        status: "failed",
        errorMessage,
      });
      captureException(error, {
        tags: { cacheOperation: "warm", trpcPath: registeredQuery.path },
        extra: { cacheKey: registeredQuery.key, userId: registeredQuery.userId },
      });
    }
  }

  if (failed > 0 && options.failOnError !== false) {
    const firstFailure = failures[0];
    throw new Error(
      `${failed} of ${keys.length} registered query caches failed to refresh; first failure: ${firstFailure?.path}: ${firstFailure?.message}`,
    );
  }
  return { refreshed, failed, skipped, outcomes };
}

export async function warmQueryCacheFromEnvironment(): Promise<void> {
  const db = createDatabaseFromEnv();
  const clickHouseClient = createClickHouseClientFromEnv();
  const sensorStore = new ClickHouseActivitySensorStore(clickHouseClient);
  const cacheRegistry = new RedisQueryCacheRegistry();
  try {
    const result = await warmRegisteredQueryCachesWithOutcomes(
      {
        cacheStore: cacheRegistry,
        db,
        sensorStore,
        createCaller: (context) => appRouter.createCaller(context satisfies Context),
        getAccessWindow: getAccessWindowForUser,
      },
      { failOnError: false },
    );
    const processingResult = await recordCacheRunForPendingProcessing(db, {
      runId: randomUUID(),
      outcomes: result.outcomes,
    });
    if (result.failed > 0 || processingResult.failed > 0) {
      const firstFailure = result.outcomes.find((outcome) => outcome.status === "failed");
      throw new Error(
        `${result.failed} registered query caches failed to refresh; first failure: ${firstFailure?.path}: ${firstFailure?.errorMessage}`,
      );
    }
    logger.info(
      `[cache-warmer] Refreshed ${result.refreshed} app query caches; skipped ${result.skipped}`,
    );
  } finally {
    await Promise.all([db.$client.end(), clickHouseClient.close?.()]);
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  await warmQueryCacheFromEnvironment();
  process.exit(0);
}
