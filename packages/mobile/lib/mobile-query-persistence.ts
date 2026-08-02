import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, type ReactNode, useMemo } from "react";
import { captureException } from "./telemetry";

export const MOBILE_QUERY_CACHE_CONTRACT_VERSION = 2;

export function mobileQueryCacheBuster(userId: string) {
  return `${userId}:v${MOBILE_QUERY_CACHE_CONTRACT_VERSION}`;
}

function queryCacheKey(userId: string) {
  return `dofek-query-cache:${userId}`;
}

const QUERY_CACHE_KEY_PREFIX = "dofek-query-cache:";

function reportQueryPersistenceFailure(source: string): void {
  captureException(new Error("Mobile query persistence operation failed."), {
    source,
  });
}

export function createMobileQueryPersister(userId: string) {
  return createAsyncStoragePersister({
    storage: AsyncStorage,
    key: queryCacheKey(userId),
    retry: () => {
      reportQueryPersistenceFailure("mobile-query-cache-persist-write");
      return undefined;
    },
  });
}

export async function removeMobileQueryCache(userId: string) {
  try {
    await AsyncStorage.removeItem(queryCacheKey(userId));
  } catch (error: unknown) {
    captureException(new Error("Mobile query persistence operation failed."), {
      source: "mobile-query-cache-clear",
    });
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
    captureException(new Error("Mobile query persistence operation failed."), {
      source: "mobile-query-cache-clear-all",
    });
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
        reportQueryPersistenceFailure("mobile-query-cache-persist");
      },
    },
    children,
  );
}
