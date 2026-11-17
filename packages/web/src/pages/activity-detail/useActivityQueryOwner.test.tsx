// @vitest-environment jsdom

import { activityQueryPlaceholder } from "@dofek/training/activity-query-placeholder";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useActivityQueryOwner } from "./useActivityQueryOwner.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useActivityQueryOwner", () => {
  it("keeps the completed owner through pending A→B→C and records cached B while it refreshes", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const bPending = deferred<string[]>();
    const cPending = deferred<string[]>();
    const key = (source: string) =>
      [["activity", "stream"], { input: { id: "activity-a", source } }] as const;
    queryClient.setQueryData(key("a"), ["a"]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result, rerender } = renderHook(
      ({ input, fn }: { input: string; fn: () => Promise<string[]> }) => {
        const query = useQuery({
          queryKey: key(input),
          queryFn: fn,
          placeholderData: activityQueryPlaceholder("activity-a"),
        });
        return {
          query,
          owner: useActivityQueryOwner("u:s:activity", "stream", { input }, query, {
            power: { sourceId: input, label: input.toUpperCase() },
          }),
        };
      },
      { wrapper, initialProps: { input: "a", fn: async () => ["a"] } },
    );

    await waitFor(() => expect(result.current.owner?.sources.power?.label).toBe("A"));
    rerender({ input: "b", fn: () => bPending.promise });
    expect(result.current.query.isPlaceholderData).toBe(true);
    expect(result.current.owner?.sources.power?.label).toBe("A");
    rerender({ input: "c", fn: () => cPending.promise });
    expect(result.current.query.data).toEqual(["a"]);
    expect(result.current.owner?.sources.power?.label).toBe("A");
    await act(async () => cPending.resolve(["c"]));
    await waitFor(() => expect(result.current.owner?.sources.power?.label).toBe("C"));
    await act(async () => bPending.resolve(["late-b"]));
    expect(result.current.query.data).toEqual(["c"]);
    expect(result.current.owner?.sources.power?.label).toBe("C");

    const cachedRefresh = deferred<string[]>();
    queryClient.setQueryData(key("b"), ["cached-b"], { updatedAt: 0 });
    rerender({ input: "b", fn: () => cachedRefresh.promise });
    await waitFor(() => expect(result.current.query.data).toEqual(["cached-b"]));
    expect(result.current.query.isFetching).toBe(true);
    expect(result.current.owner?.sources.power?.label).toBe("B");
    await act(async () => cachedRefresh.resolve(["fresh-b"]));
    queryClient.clear();
  });

  it("does not resurrect a failed first request and keeps cached data through a background error", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = (source: string) =>
      [["activity", "stream"], { input: { id: "activity-a", source } }] as const;
    queryClient.setQueryData(key("a"), ["a"]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const failedRefresh = deferred<string[]>();
    const { result, rerender } = renderHook(
      ({ input, fn }: { input: string; fn: () => Promise<string[]> }) => {
        const query = useQuery({
          queryKey: key(input),
          queryFn: fn,
          placeholderData: activityQueryPlaceholder("activity-a"),
        });
        return {
          query,
          owner: useActivityQueryOwner("user:session:activity-a", "stream", { input }, query, {
            power: { sourceId: input, label: input.toUpperCase() },
          }),
        };
      },
      { wrapper, initialProps: { input: "a", fn: async () => ["a"] } },
    );
    await waitFor(() => expect(result.current.owner?.sources.power?.label).toBe("A"));

    rerender({ input: "b", fn: () => Promise.reject(new Error("B failed")) });
    await waitFor(() => expect(result.current.query.error?.message).toBe("B failed"));
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.owner).toBeNull();

    rerender({ input: "c", fn: async () => ["recovered-c"] });
    await waitFor(() => expect(result.current.owner?.sources.power?.label).toBe("C"));

    queryClient.setQueryData(key("d"), ["cached-d"], { updatedAt: 0 });
    rerender({ input: "d", fn: () => failedRefresh.promise });
    await waitFor(() => expect(result.current.query.data).toEqual(["cached-d"]));
    expect(result.current.owner?.sources.power?.label).toBe("D");
    await waitFor(() => expect(result.current.query.isFetching).toBe(true));
    await act(async () => failedRefresh.reject(new Error("Background failed")));
    await waitFor(() => expect(result.current.query.error?.message).toBe("Background failed"));
    expect(result.current.query.data).toEqual(["cached-d"]);
    expect(result.current.owner?.sources.power?.label).toBe("D");
    queryClient.clear();
  });

  it("keeps unknown canonical attribution unknown and resets ownership across activity scope", () => {
    const prior = { data: [1] };
    const { result, rerender } = renderHook(
      ({
        scope,
        input,
        sources,
        placeholder,
      }: {
        scope: string;
        input: object;
        sources: { power?: { sourceId: string; label: string | null } };
        placeholder: boolean;
      }) =>
        useActivityQueryOwner(
          scope,
          "stream",
          input,
          { ...prior, isPlaceholderData: placeholder },
          sources,
        ),
      {
        initialProps: {
          scope: "u:s:a",
          input: { id: "a", sources: {} },
          sources: {},
          placeholder: false,
        },
      },
    );
    expect(result.current?.sources).toEqual({});
    rerender({
      scope: "u:s:a",
      input: { id: "a", sources: { power: "b" } },
      sources: { power: { sourceId: "b", label: "B" } },
      placeholder: true,
    });
    expect(result.current?.sources).toEqual({});
    rerender({
      scope: "u:s:b",
      input: { id: "b", sources: { power: "b" } },
      sources: { power: { sourceId: "b", label: "B" } },
      placeholder: false,
    });
    expect(result.current?.sources).toEqual({ power: { sourceId: "b", label: "B" } });
  });

  it("updates attribution for equal structurally shared data when the observed input changes", () => {
    const sharedData = [1];
    const { result, rerender } = renderHook(
      ({ input }: { input: string }) =>
        useActivityQueryOwner(
          "user:session:activity",
          "stream",
          { input },
          { data: sharedData, isPlaceholderData: false },
          { power: { sourceId: input, label: input.toUpperCase() } },
        ),
      { initialProps: { input: "a" } },
    );
    expect(result.current?.sources.power?.label).toBe("A");
    rerender({ input: "b" });
    expect(result.current?.sources.power?.label).toBe("B");
  });

  it("advances stream, context, zones and work owners only for each completed family", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const families = ["stream", "heartRateContext", "hrZones", "powerZones", "powerWork"] as const;
    const key = (family: (typeof families)[number], source: string) =>
      [["activity", family], { input: { id: "activity-a", source } }] as const;
    for (const family of families) queryClient.setQueryData(key(family, "a"), [family, "a"]);
    const streamPending = deferred<string[]>();
    const contextPending = deferred<string[]>();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const useFamilyOwner = (family: (typeof families)[number], source: string) => {
      const query = useQuery({
        queryKey: key(family, source),
        queryFn: () =>
          family === "stream" && source === "b"
            ? streamPending.promise
            : family === "heartRateContext" && source === "c"
              ? contextPending.promise
              : Promise.resolve([family, source]),
        placeholderData: activityQueryPlaceholder("activity-a"),
      });
      return useActivityQueryOwner(
        "user-a:session-a:activity-a",
        family,
        { id: "activity-a", source },
        query,
        { power: { sourceId: source, label: source.toUpperCase() } },
      );
    };
    const { result, rerender } = renderHook(
      ({ stream, context }: { stream: string; context: string }) => ({
        stream: useFamilyOwner("stream", stream),
        context: useFamilyOwner("heartRateContext", context),
        hrZones: useFamilyOwner("hrZones", "a"),
        powerZones: useFamilyOwner("powerZones", "a"),
        powerWork: useFamilyOwner("powerWork", "a"),
      }),
      { wrapper, initialProps: { stream: "a", context: "a" } },
    );
    expect(result.current.stream?.sources.power?.label).toBe("A");
    expect(result.current.context?.sources.power?.label).toBe("A");
    rerender({ stream: "b", context: "a" });
    expect(result.current.stream?.sources.power?.label).toBe("A");
    expect(result.current.context?.sources.power?.label).toBe("A");
    queryClient.setQueryData(key("heartRateContext", "c"), ["cached-context-c"]);
    rerender({ stream: "b", context: "c" });
    await waitFor(() => expect(result.current.context?.sources.power?.label).toBe("C"));
    expect(result.current.stream?.sources.power?.label).toBe("A");
    expect(result.current.hrZones?.sources.power?.label).toBe("A");
    expect(result.current.powerZones?.sources.power?.label).toBe("A");
    expect(result.current.powerWork?.sources.power?.label).toBe("A");
    await act(async () => {
      streamPending.resolve(["stream-b"]);
      contextPending.resolve(["context-c"]);
    });
    queryClient.clear();
  });
});
