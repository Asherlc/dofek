import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import {
  persistQueryClient,
  persistQueryClientRestore,
} from "@tanstack/react-query-persist-client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMobileQueryPersister,
  MOBILE_QUERY_CACHE_CONTRACT_VERSION,
  MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES,
  mobileQueryCacheBuster,
  removeMobileQueryCache,
} from "./mobile-query-persistence";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

describe("mobile query persistence", () => {
  beforeEach(async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.clear();
  });

  it("uses a new cache contract buster for epistemic status fields", () => {
    expect(MOBILE_QUERY_CACHE_CONTRACT_VERSION).toBe(7);
    expect(mobileQueryCacheBuster("user-1")).toBe("user-1:v7");
  });

  it("restores persisted user data before the query refetches", async () => {
    let resolveRefetch: ((value: { readiness: string }) => void) | undefined;
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: mobileQueryCacheBuster("user-1"),
        clientState: dehydrate(seedClient),
      }),
    );

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
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    expect(restoredClient.getQueryData(["dashboard"])).toEqual({ readiness: "cached" });
    resolveRefetch?.({ readiness: "fresh" });
    await refetch;
  });

  it("discards persisted data from the previous cache contract", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["food", "byDate"], {
      entries: [],
      summary: { calories: 1000 },
    });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: "user-1:v6",
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    expect(restoredClient.getQueryData(["food", "byDate"])).toBeUndefined();
  });

  it("scopes persisted data by authenticated user", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: mobileQueryCacheBuster("user-1"),
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-2"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-2"),
    });

    expect(restoredClient.getQueryData(["dashboard"])).toBeUndefined();
  });

  it("does not restore expired persisted data", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "old" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now() - QUERY_CACHE_MAX_AGE_MS - 1,
        buster: mobileQueryCacheBuster("user-1"),
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    expect(restoredClient.getQueryData(["dashboard"])).toBeUndefined();
  });

  it("clears only the active user's persisted cache on logout", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.setItem("dofek-query-cache:user-1", "cache");
    await AsyncStorage.setItem("dofek-query-cache:user-2", "cache");

    await removeMobileQueryCache("user-1");

    await expect(AsyncStorage.getItem("dofek-query-cache:user-1")).resolves.toBeNull();
    await expect(AsyncStorage.getItem("dofek-query-cache:user-2")).resolves.toBe("cache");
  });

  it("drops oversized persisted caches instead of writing them (DOFEK-MOBILE-1E)", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const client = createQueryClient();
    client.setQueryData(["huge"], "x".repeat(MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES));

    await persistQueryClient({
      queryClient: client,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    await expect(AsyncStorage.getItem("dofek-query-cache:user-1")).resolves.toBeNull();
  });
});
