import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, type ReactNode } from "react";

function queryCacheKey(userId: string) {
  return `dofek-query-cache:${userId}`;
}

export function createWebQueryPersister(userId: string) {
  return createSyncStoragePersister({
    storage: window.localStorage,
    key: queryCacheKey(userId),
  });
}

export function removeWebQueryCache(userId: string) {
  window.localStorage.removeItem(queryCacheKey(userId));
}

export function WebQueryPersistenceProvider({
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
        persister: createWebQueryPersister(userId),
        maxAge: QUERY_CACHE_MAX_AGE_MS,
        buster: userId,
      },
    },
    children,
  );
}
