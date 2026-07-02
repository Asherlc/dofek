import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createElement, useMemo, type ReactNode } from "react";
import { captureException } from "./telemetry.ts";

function queryCacheKey(userId: string) {
  return `dofek-query-cache:${userId}`;
}

export function createWebQueryPersister(userId: string) {
  return createAsyncStoragePersister({
    storage: window.localStorage,
    key: queryCacheKey(userId),
  });
}

export function removeWebQueryCache(userId: string) {
  try {
    window.localStorage?.removeItem(queryCacheKey(userId));
  } catch (error: unknown) {
    captureException(error, { source: "web-query-cache-clear", userId });
  }
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
  const persister = useMemo(() => createWebQueryPersister(userId), [userId]);

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
          source: "web-query-cache-persist",
          userId,
        });
      },
    },
    children,
  );
}
