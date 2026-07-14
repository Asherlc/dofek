import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { getAccessWindowForUser } from "../packages/server/src/billing/access-window-repository.ts";
import type { AccessWindow } from "../packages/server/src/billing/entitlement.ts";
import { ClickHouseActivitySensorStore } from "../packages/server/src/repositories/clickhouse-activity-sensor-store.ts";
import { appRouter } from "../packages/server/src/router.ts";
import type { Context } from "../packages/server/src/trpc.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { queryCache } from "../src/lib/cache.ts";
import { logger } from "../src/logger.ts";

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
    Sentry.captureException(error, { tags: { cacheOperation: "parseWarmKey" } });
    return null;
  }
}

async function invokeCallerProcedure(caller: unknown, path: string, input: unknown): Promise<void> {
  let procedure: unknown = caller;
  for (const pathSegment of path.split(".")) {
    if ((typeof procedure !== "object" || procedure === null) && typeof procedure !== "function") {
      throw new Error(`Cached tRPC procedure path is not callable: ${path}`);
    }
    procedure = Reflect.get(procedure, pathSegment);
  }
  if (typeof procedure !== "function") {
    throw new Error(`Cached tRPC procedure path is not callable: ${path}`);
  }
  await Reflect.apply(procedure, undefined, [input]);
}

export async function warmRegisteredQueryCaches<TDatabase, TSensorStore>(
  input: WarmRegisteredQueryCachesInput<TDatabase, TSensorStore>,
): Promise<{ refreshed: number; failed: number; skipped: number }> {
  const keys = await input.cacheStore.listKeys();
  const accessWindows = new Map<string, AccessWindow>();
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ path: string; message: string }> = [];

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
    } catch (error) {
      failed += 1;
      failures.push({
        path: registeredQuery.path,
        message: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { cacheOperation: "warm", trpcPath: registeredQuery.path },
        extra: { cacheKey: registeredQuery.key, userId: registeredQuery.userId },
      });
    }
  }

  if (failed > 0) {
    const firstFailure = failures[0];
    throw new Error(
      `${failed} of ${keys.length} registered query caches failed to refresh; first failure: ${firstFailure?.path}: ${firstFailure?.message}`,
    );
  }
  return { refreshed, failed, skipped };
}

async function main(): Promise<void> {
  const db = createDatabaseFromEnv();
  const clickHouseClient = createClickHouseClientFromEnv();
  const sensorStore = new ClickHouseActivitySensorStore(clickHouseClient);
  try {
    const result = await warmRegisteredQueryCaches({
      cacheStore: queryCache,
      db,
      sensorStore,
      createCaller: (context) => appRouter.createCaller(context satisfies Context),
      getAccessWindow: getAccessWindowForUser,
    });
    logger.info(
      `[cache-warmer] Refreshed ${result.refreshed} app query caches; skipped ${result.skipped}`,
    );
  } finally {
    await clickHouseClient.close?.();
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  await main();
}
