import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, type ReactNode, useMemo } from "react";
import { captureException, logger } from "./telemetry";

export const MOBILE_QUERY_CACHE_CONTRACT_VERSION = 9;
export const MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES = 5 * 1024 * 1024;

export function mobileQueryCacheBuster(userId: string) {
  return `${userId}:v${MOBILE_QUERY_CACHE_CONTRACT_VERSION}`;
}

function queryCacheKey(userId: string) {
  return `dofek-query-cache:${userId}`;
}

const QUERY_CACHE_KEY_PREFIX = "dofek-query-cache:";
const storageErrorCategories = new Map([
  ["Failed to read storage file.", "read-file"],
  ["Failed to write manifest file.", "write-manifest"],
  ["Failed to write value.", "write-value"],
  ["Failed to create storage directory.", "create-directory"],
  ["Failed to delete storage directory.", "delete-directory"],
]);

function reportQueryPersistenceFailure(
  error: unknown,
  source: string,
  measurements: Record<string, number> = {},
): void {
  // AsyncStorage's iOS bridge keeps its fixed message but discards NSError codes.
  // Never send its error object: messages, keys and userInfo can contain health data.
  // AsyncStorage multiRemove rejects an error array; classify its first error for telemetry.
  const failure: unknown = Array.isArray(error) ? error[0] : error;
  const category =
    failure instanceof SyntaxError
      ? "invalid-json"
      : failure instanceof Error
        ? storageErrorCategories.get(failure.message)
        : undefined;
  const code =
    typeof failure === "object" &&
    failure !== null &&
    "code" in failure &&
    typeof failure.code === "string" &&
    ["EACCES", "EPERM", "ENOSPC", "EIO", "ENOENT", "SQLITE_FULL"].includes(failure.code)
      ? failure.code
      : "unknown";
  captureException(new Error("Mobile query persistence operation failed."), {
    source,
    category: category ?? "unknown",
    code,
    ...measurements,
  });
}

function createBoundedAsyncStorage(measurements: {
  writeCount: number;
  totalWriteBytes: number;
  writeBytes: number;
}) {
  return {
    getItem: async (key: string) => {
      try {
        return await AsyncStorage.getItem(key);
      } catch (error: unknown) {
        reportQueryPersistenceFailure(error, "mobile-query-cache-persist-read");
        throw error;
      }
    },
    setItem: async (key: string, value: string) => {
      const bytes = new TextEncoder().encode(value).byteLength;
      measurements.writeBytes = bytes;
      if (bytes > MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES) {
        await AsyncStorage.removeItem(key);
        logger.info("mobile-query-cache", "Dropped oversized query cache.", { ...measurements });
        return;
      }
      measurements.writeCount += 1;
      measurements.totalWriteBytes += bytes;
      await AsyncStorage.setItem(key, value);
      logger.info("mobile-query-cache", "Persisted query cache.", { ...measurements });
    },
    removeItem: async (key: string) => {
      try {
        await AsyncStorage.removeItem(key);
      } catch (error: unknown) {
        reportQueryPersistenceFailure(error, "mobile-query-cache-persist-remove");
        throw error;
      }
    },
  };
}

export function createMobileQueryPersister(userId: string) {
  const measurements = { writeCount: 0, totalWriteBytes: 0, writeBytes: 0 };
  return createAsyncStoragePersister({
    storage: createBoundedAsyncStorage(measurements),
    key: queryCacheKey(userId),
    deserialize: (value) => {
      try {
        return JSON.parse(value);
      } catch (error: unknown) {
        reportQueryPersistenceFailure(error, "mobile-query-cache-deserialize");
        throw error;
      }
    },
    serialize: (client) => {
      measurements.writeBytes = 0;
      return JSON.stringify(client);
    },
    retry: ({ error }) => {
      reportQueryPersistenceFailure(
        error,
        measurements.writeBytes > MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES
          ? "mobile-query-cache-persist-remove"
          : "mobile-query-cache-persist-write",
        measurements,
      );
      return undefined;
    },
  });
}

export async function removeMobileQueryCache(userId: string) {
  try {
    await AsyncStorage.removeItem(queryCacheKey(userId));
  } catch (error: unknown) {
    reportQueryPersistenceFailure(error, "mobile-query-cache-clear");
    throw error;
  }
}

export async function removeAllMobileQueryCaches(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const accountCacheKeys = keys.filter((key) => key.startsWith(QUERY_CACHE_KEY_PREFIX));
    if (accountCacheKeys.length > 0) {
      await AsyncStorage.multiRemove(accountCacheKeys);
    }
  } catch (error: unknown) {
    reportQueryPersistenceFailure(error, "mobile-query-cache-clear-all");
    throw error;
  }
}

export function MobileQueryPersistenceProvider({
  children,
  queryClient,
  userId,
}: {
  children: ReactNode;
  queryClient: QueryClient;
  userId: string;
}) {
  const persister = useMemo(() => createMobileQueryPersister(userId), [userId]);

  return createElement(
    PersistQueryClientProvider,
    {
      client: queryClient,
      persistOptions: {
        persister,
        maxAge: QUERY_CACHE_MAX_AGE_MS,
        buster: mobileQueryCacheBuster(userId),
      },
      onError: () => {
        // This callback has no error argument and also covers failures during hydration.
        // Boundary reports retain available classifications; this fallback stays generic.
        reportQueryPersistenceFailure(undefined, "mobile-query-cache-persist");
      },
    },
    children,
  );
}
