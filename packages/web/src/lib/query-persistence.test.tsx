/* @vitest-environment jsdom */

import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client";
import { beforeEach, describe, expect, it } from "vitest";
import { createWebQueryPersister, removeWebQueryCache } from "./query-persistence.ts";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

describe("web query persistence", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } satisfies Storage;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    window.localStorage.clear();
  });

  it("restores persisted user data before the query refetches", async () => {
    let resolveRefetch: ((value: { readiness: string }) => void) | undefined;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    const persistedClient = {
      timestamp: Date.now(),
      buster: "user-1",
      clientState: dehydrate(seedClient),
    };
    window.localStorage.setItem("dofek-query-cache:user-1", JSON.stringify(persistedClient));

    const restoredClient = createQueryClient();
    const refetch = restoredClient.fetchQuery({
      queryKey: ["dashboard"],
      queryFn: () =>
        new Promise<{ readiness: string }>((resolve) => {
          resolveRefetch = resolve;
        }),
    });
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createWebQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: "user-1",
    });

    expect(restoredClient.getQueryData(["dashboard"])).toEqual({ readiness: "cached" });
    resolveRefetch?.({ readiness: "fresh" });
    await refetch;
  });

  it("scopes persisted data by authenticated user", async () => {
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    window.localStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: "user-1",
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createWebQueryPersister("user-2"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: "user-2",
    });

    expect(restoredClient.getQueryData(["dashboard"])).toBeUndefined();
  });

  it("does not restore expired persisted data", async () => {
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "old" });
    window.localStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now() - QUERY_CACHE_MAX_AGE_MS - 1,
        buster: "user-1",
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createWebQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: "user-1",
    });

    expect(restoredClient.getQueryData(["dashboard"])).toBeUndefined();
  });

  it("clears only the active user's persisted cache on logout", () => {
    window.localStorage.setItem("dofek-query-cache:user-1", "cache");
    window.localStorage.setItem("dofek-query-cache:user-2", "cache");

    removeWebQueryCache("user-1");

    expect(window.localStorage.getItem("dofek-query-cache:user-1")).toBeNull();
    expect(window.localStorage.getItem("dofek-query-cache:user-2")).toBe("cache");
  });
});
