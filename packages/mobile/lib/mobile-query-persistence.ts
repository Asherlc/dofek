import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, type ReactNode, useMemo } from "react";
import { captureException } from "./telemetry";

export const MOBILE_QUERY_CACHE_CONTRACT_VERSION = 3;

export function mobileQueryCacheBuster(userId: string) {
  return `${userId}:v${MOBILE_QUERY_CACHE_CONTRACT_VERSION}`;
}

function queryCacheKey(userId: string) {
  return `dofek-query-cache:${userId}`;
}

export function createMobileQueryPersister(userId: string) {
  return createAsyncStoragePersister({
    storage: AsyncStorage,
    key: queryCacheKey(userId),
    retry: ({ error }) => {
      captureException(error, { source: "mobile-query-cache-persist-write", userId });
      return undefined;
    },
  });
}

export async function removeMobileQueryCache(userId: string) {
  try {
    await AsyncStorage.removeItem(queryCacheKey(userId));
  } catch (error: unknown) {
    captureException(error, { source: "mobile-query-cache-clear", userId });
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
        captureException(new Error("Failed to restore persisted query cache"), {
          source: "mobile-query-cache-persist",
          userId,
        });
      },
    },
    children,
  );
}
