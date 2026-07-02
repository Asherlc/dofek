import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, type ReactNode } from "react";

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
  return createElement(
    PersistQueryClientProvider,
    {
      client: queryClient,
      persistOptions: {
        persister: createMobileQueryPersister(userId),
        maxAge: QUERY_CACHE_MAX_AGE_MS,
        buster: userId,
      },
    },
    children,
  );
}
