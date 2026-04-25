import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheStore, NullCacheStore, queryCache } from "./cache.ts";

describe("MemoryCacheStore", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await queryCache.invalidateAll();
  });

  it("returns undefined for missing keys", async () => {
    expect(await queryCache.get("nonexistent")).toBeUndefined();
  });

  it("stores and retrieves values", async () => {
    await queryCache.set("key1", { value: 42 }, 60_000);
    expect(await queryCache.get("key1")).toEqual({ value: 42 });
  });

  it("returns undefined for expired entries", async () => {
    vi.useFakeTimers();
    await queryCache.set("expires", "data", 1000);

    expect(await queryCache.get("expires")).toBe("data");

    vi.advanceTimersByTime(1001);
    expect(await queryCache.get("expires")).toBeUndefined();

    vi.useRealTimers();
  });

  it("expires entries exactly at the TTL boundary", async () => {
    vi.useFakeTimers();

    try {
      await queryCache.set("expires-at-boundary", "data", 1000);

      vi.advanceTimersByTime(1000);

      expect(await queryCache.get("expires-at-boundary")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("overwrites existing entries", async () => {
    await queryCache.set("key", "first", 60_000);
    await queryCache.set("key", "second", 60_000);
    expect(await queryCache.get("key")).toBe("second");
  });

  it("invalidateByPrefix removes only matching keys", async () => {
    await queryCache.set("user1:food.byDate:{}", "data1", 60_000);
    await queryCache.set("user1:food.dailyTotals:{}", "data2", 60_000);
    await queryCache.set("user1:nutrition.daily:{}", "data3", 60_000);
    await queryCache.set("user2:food.byDate:{}", "data4", 60_000);

    await queryCache.invalidateByPrefix("user1:food.");

    expect(await queryCache.get("user1:food.byDate:{}")).toBeUndefined();
    expect(await queryCache.get("user1:food.dailyTotals:{}")).toBeUndefined();
    expect(await queryCache.get("user1:nutrition.daily:{}")).toBe("data3");
    expect(await queryCache.get("user2:food.byDate:{}")).toBe("data4");
  });

  it("invalidateAll clears all entries", async () => {
    await queryCache.set("a", 1, 60_000);
    await queryCache.set("b", 2, 60_000);

    await queryCache.invalidateAll();

    expect(await queryCache.get("a")).toBeUndefined();
    expect(await queryCache.get("b")).toBeUndefined();
  });

  it("schedules a default sweep interval and unreferences object interval handles", async () => {
    vi.useFakeTimers();

    const originalSetInterval = globalThis.setInterval;
    let unrefCallCount = 0;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback, delay, ...rest) => {
        expect(delay).toBe(5 * 60 * 1000);
        const intervalHandle = originalSetInterval(callback, delay, ...rest);
        vi.spyOn(intervalHandle, "unref").mockImplementation(() => {
          unrefCallCount += 1;
          return intervalHandle;
        });
        return intervalHandle;
      });
    const deleteSpy = vi.spyOn(Map.prototype, "delete");

    const store = new MemoryCacheStore();
    await store.set("expired", "old", 1000);
    await store.set("fresh", "new", 400_000);

    vi.advanceTimersByTime(60_000);
    expect(deleteSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4 * 60 * 1000);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unrefCallCount).toBe(1);
    expect(deleteSpy).toHaveBeenCalledWith("expired");
    expect(deleteSpy).not.toHaveBeenCalledWith("fresh");
  });
});

describe("NullCacheStore", () => {
  it("always returns undefined", async () => {
    const store = new NullCacheStore();

    await expect(store.get("missing")).resolves.toBeUndefined();
  });
});
