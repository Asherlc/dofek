/* @vitest-environment jsdom */

import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebQueryPersister,
  removeWebQueryCache,
  WebQueryPersistenceProvider,
} from "./query-persistence.ts";

type CapturedPersistProviderProps = {
  client: QueryClient;
  persistOptions: {
    persister: ReturnType<typeof createWebQueryPersister>;
    maxAge: number;
    buster: string;
  };
  onError: () => void;
  children: React.ReactNode;
};

const mockCaptureException = vi.hoisted(() => vi.fn());
const capturedPersistProviders = vi.hoisted((): CapturedPersistProviderProps[] => []);

vi.mock("./telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("@tanstack/react-query-persist-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query-persist-client")>();
  return {
    ...original,
    PersistQueryClientProvider: (props: CapturedPersistProviderProps) => {
      capturedPersistProviders.push(props);
      return props.children;
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
    mockCaptureException.mockClear();
    capturedPersistProviders.length = 0;
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

  it("does not throw when clearing cache without localStorage", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: undefined,
    });

    expect(() => removeWebQueryCache("user-1")).not.toThrow();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("reports storage failures when clearing cache", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        removeItem: () => {
          throw new Error("SecurityError");
        },
      },
    });

    removeWebQueryCache("user-1");

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "web-query-cache-clear",
      userId: "user-1",
    });
  });

  it("passes user-scoped persist options to the provider", () => {
    const queryClient = createQueryClient();
    render(
      <WebQueryPersistenceProvider queryClient={queryClient} userId="user-1">
        <span>child</span>
      </WebQueryPersistenceProvider>,
    );

    const props = capturedPersistProviders.at(-1);
    expect(props).toMatchObject({
      client: queryClient,
      persistOptions: {
        maxAge: QUERY_CACHE_MAX_AGE_MS,
        buster: "user-1",
      },
    });
    expect(props?.persistOptions.persister).toBeDefined();
  });

  it("updates the persister when the authenticated user changes", () => {
    const queryClient = createQueryClient();
    const { rerender } = render(
      <WebQueryPersistenceProvider queryClient={queryClient} userId="user-1">
        <span>child</span>
      </WebQueryPersistenceProvider>,
    );

    const firstPersister = capturedPersistProviders.at(-1)?.persistOptions.persister;

    rerender(
      <WebQueryPersistenceProvider queryClient={queryClient} userId="user-2">
        <span>child</span>
      </WebQueryPersistenceProvider>,
    );

    const nextProps = capturedPersistProviders.at(-1);
    expect(nextProps?.persistOptions.buster).toBe("user-2");
    expect(nextProps?.persistOptions.persister).not.toBe(firstPersister);
  });

  it("reports restore failures through the persistence provider", () => {
    const queryClient = createQueryClient();
    render(
      <WebQueryPersistenceProvider queryClient={queryClient} userId="user-1">
        <span>child</span>
      </WebQueryPersistenceProvider>,
    );

    capturedPersistProviders.at(-1)?.onError();

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Failed to restore persisted query cache" }),
      { source: "web-query-cache-persist", userId: "user-1" },
    );
  });
});
