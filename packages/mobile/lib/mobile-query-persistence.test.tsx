import { dehydrate, QueryClient } from "@tanstack/react-query";
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMobileQueryPersister,
  QUERY_CACHE_MAX_AGE_MS,
  removeMobileQueryCache,
} from "./mobile-query-persistence";

vi.mock("@react-native-async-storage/async-storage", () => {
  const values = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
        return Promise.resolve();
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        values.clear();
        return Promise.resolve();
      }),
    },
  };
});

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

  it("restores persisted user data before the query refetches", async () => {
    let resolveRefetch: ((value: { readiness: string }) => void) | undefined;
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: "user-1",
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
      buster: "user-1",
    });

    expect(restoredClient.getQueryData(["dashboard"])).toEqual({ readiness: "cached" });
    resolveRefetch?.({ readiness: "fresh" });
    await refetch;
  });

  it("scopes persisted data by authenticated user", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    await AsyncStorage.setItem(
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
      persister: createMobileQueryPersister("user-2"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: "user-2",
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
        buster: "user-1",
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: "user-1",
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
});
