import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, useMemo, type ReactNode } from "react";
import { captureException } from "./telemetry";

function queryCacheKey(userId: string) {
  return `dofek-query-cache:${userId}`;
}

export function createMobileQueryPersister(userId: string) {
  return createAsyncStoragePersister({
    storage: AsyncStorage,
    key: queryCacheKey(userId),
  });
}

export async function removeMobileQueryCache(userId: string) {
  await AsyncStorage.removeItem(queryCacheKey(userId));
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
        buster: userId,
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
