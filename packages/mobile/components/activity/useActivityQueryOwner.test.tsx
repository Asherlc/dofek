// @vitest-environment jsdom

import { activityQueryPlaceholder } from "@dofek/training/activity-query-placeholder";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useActivityQueryOwner } from "./useActivityQueryOwner";

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
  it("uses observed query inputs for pending, cached and completed stream readings", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const bRefresh = deferred<string[]>();
    const cPending = deferred<string[]>();
    queryClient.setQueryData(["stream", "a"], ["a"]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result, rerender } = renderHook(
      ({ input, fn }: { input: string; fn: () => Promise<string[]> }) => {
        const query = useQuery({
          queryKey: ["stream", input],
          queryFn: fn,
          placeholderData: (previous) => previous,
        });
        return {
          query,
          owner: useActivityQueryOwner("u:s:activity", "stream", { input }, query, {
            skinTemperature: { sourceId: input, label: input.toUpperCase() },
          }),
        };
      },
      { wrapper, initialProps: { input: "a", fn: async () => ["a"] } },
    );
    await waitFor(() => expect(result.current.owner?.sources.skinTemperature?.label).toBe("A"));
    rerender({ input: "b", fn: () => bRefresh.promise });
    expect(result.current.owner?.sources.skinTemperature?.label).toBe("A");
    rerender({ input: "c", fn: () => cPending.promise });
    await act(async () => cPending.resolve(["c"]));
    await waitFor(() => expect(result.current.owner?.sources.skinTemperature?.label).toBe("C"));
    queryClient.setQueryData(["stream", "b"], ["cached-b"]);
    rerender({ input: "b", fn: () => bRefresh.promise });
    await waitFor(() => expect(result.current.query.data).toEqual(["cached-b"]));
    expect(result.current.query.isFetching).toBe(true);
    expect(result.current.owner?.sources.skinTemperature?.label).toBe("B");
    await act(async () => bRefresh.resolve(["fresh-b"]));
    queryClient.clear();
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
        { skinTemperature: { sourceId: source, label: source.toUpperCase() } },
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
    expect(result.current.stream?.sources.skinTemperature?.label).toBe("A");
    expect(result.current.context?.sources.skinTemperature?.label).toBe("A");
    rerender({ stream: "b", context: "a" });
    expect(result.current.stream?.sources.skinTemperature?.label).toBe("A");
    expect(result.current.context?.sources.skinTemperature?.label).toBe("A");
    queryClient.setQueryData(key("heartRateContext", "c"), ["cached-context-c"]);
    rerender({ stream: "b", context: "c" });
    await waitFor(() => expect(result.current.context?.sources.skinTemperature?.label).toBe("C"));
    expect(result.current.stream?.sources.skinTemperature?.label).toBe("A");
    expect(result.current.hrZones?.sources.skinTemperature?.label).toBe("A");
    expect(result.current.powerZones?.sources.skinTemperature?.label).toBe("A");
    expect(result.current.powerWork?.sources.skinTemperature?.label).toBe("A");
    await act(async () => {
      streamPending.resolve(["stream-b"]);
      contextPending.resolve(["context-c"]);
    });
    queryClient.clear();
  });

  it("clears failed first-request ownership and retains cached data through a background error", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = (source: string) =>
      [["activity", "stream"], { input: { id: "activity-a", source } }] as const;
    queryClient.setQueryData(key("a"), ["a"]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const backgroundRefresh = deferred<string[]>();
    const { result, rerender } = renderHook(
      ({ input, fn }: { input: string; fn: () => Promise<string[]> }) => {
        const query = useQuery({
          queryKey: key(input),
          queryFn: fn,
          placeholderData: activityQueryPlaceholder("activity-a"),
        });
        return {
          query,
          owner: useActivityQueryOwner("user-a:session-a:activity-a", "stream", { input }, query, {
            skinTemperature: { sourceId: input, label: input.toUpperCase() },
          }),
        };
      },
      { wrapper, initialProps: { input: "a", fn: async () => ["a"] } },
    );
    await waitFor(() => expect(result.current.owner?.sources.skinTemperature?.label).toBe("A"));
    rerender({ input: "b", fn: () => Promise.reject(new Error("B failed")) });
    await waitFor(() => expect(result.current.query.error?.message).toBe("B failed"));
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.owner).toBeNull();
    rerender({ input: "c", fn: async () => ["recovered-c"] });
    await waitFor(() => expect(result.current.owner?.sources.skinTemperature?.label).toBe("C"));
    queryClient.setQueryData(key("d"), ["cached-d"], { updatedAt: 0 });
    rerender({ input: "d", fn: () => backgroundRefresh.promise });
    await waitFor(() => expect(result.current.query.data).toEqual(["cached-d"]));
    expect(result.current.owner?.sources.skinTemperature?.label).toBe("D");
    await waitFor(() => expect(result.current.query.isFetching).toBe(true));
    await act(async () => backgroundRefresh.reject(new Error("Background failed")));
    await waitFor(() => expect(result.current.query.error?.message).toBe("Background failed"));
    expect(result.current.query.data).toEqual(["cached-d"]);
    expect(result.current.owner?.sources.skinTemperature?.label).toBe("D");
    queryClient.clear();
  });

  it("updates for equal data under a new input and resets across user and activity scopes", () => {
    const sharedData = [1];
    const { result, rerender } = renderHook(
      ({ scope, input }: { scope: string; input: string }) =>
        useActivityQueryOwner(
          scope,
          "stream",
          { id: input, sources: { skinTemperature: input } },
          { data: sharedData, isPlaceholderData: false },
          { skinTemperature: { sourceId: input, label: input.toUpperCase() } },
        ),
      { initialProps: { scope: "user-a:session-a:activity-a", input: "a" } },
    );
    expect(result.current?.sources.skinTemperature?.label).toBe("A");
    rerender({ scope: "user-a:session-a:activity-a", input: "b" });
    expect(result.current?.sources.skinTemperature?.label).toBe("B");
    rerender({ scope: "user-b:session-b:activity-b", input: "c" });
    expect(result.current?.sources.skinTemperature?.label).toBe("C");
  });
});
