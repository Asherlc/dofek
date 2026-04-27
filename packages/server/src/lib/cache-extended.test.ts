import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryCache } from "dofek/lib/cache";

describe("MemoryCacheStore — extended tests", () => {
  beforeEach(async () => {
    await queryCache.invalidateAll();
  });

  afterEach(async () => {
    await queryCache.invalidateAll();
  });

  describe("cache miss behavior", () => {
    it("returns undefined for a key that was never set", async () => {
      const result = await queryCache.get("nonexistent:key");
      expect(result).toBeUndefined();
    });

    it("returns undefined for a key after it is explicitly deleted by prefix", async () => {
      await queryCache.set("user:data.metrics", { value: 42 }, 60_000);
      expect(await queryCache.get("user:data.metrics")).toEqual({ value: 42 });

      await queryCache.invalidateByPrefix("user:data.");
      expect(await queryCache.get("user:data.metrics")).toBeUndefined();
    });
  });

  describe("TTL expiration behavior", () => {
    it("returns undefined after TTL expires", async () => {
      vi.useFakeTimers();

      try {
        await queryCache.set("ttl-test:key", "value", 1000); // 1 second TTL
        expect(await queryCache.get("ttl-test:key")).toBe("value");

        // Advance time past the TTL
        vi.advanceTimersByTime(1001);

        expect(await queryCache.get("ttl-test:key")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns value before TTL expires", async () => {
      vi.useFakeTimers();

      try {
        await queryCache.set("ttl-test:fresh", "fresh-value", 5000);

        // Advance less than TTL
        vi.advanceTimersByTime(3000);

        expect(await queryCache.get("ttl-test:fresh")).toBe("fresh-value");
      } finally {
        vi.useRealTimers();
      }
    });

    it("handles zero TTL (immediate expiration)", async () => {
      vi.useFakeTimers();

      try {
        await queryCache.set("ttl-test:zero", "value", 0);

        // Advance by 1ms
        vi.advanceTimersByTime(1);

        expect(await queryCache.get("ttl-test:zero")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("invalidateAll", () => {
    it("clears all entries from the cache", async () => {
      await queryCache.set("a:1", "val1", 60_000);
      await queryCache.set("b:2", "val2", 60_000);
      await queryCache.set("c:3", "val3", 60_000);

      await queryCache.invalidateAll();

      expect(await queryCache.get("a:1")).toBeUndefined();
      expect(await queryCache.get("b:2")).toBeUndefined();
      expect(await queryCache.get("c:3")).toBeUndefined();
    });
  });

  describe("set and get with complex data types", () => {
    it("caches and retrieves arrays", async () => {
      const data = [1, 2, 3, "four", { five: 5 }];
      await queryCache.set("complex:array", data, 60_000);
      expect(await queryCache.get("complex:array")).toEqual(data);
    });

    it("caches and retrieves nested objects", async () => {
      const data = {
        user: { name: "Test", settings: { theme: "dark" } },
        scores: [100, 200],
      };
      await queryCache.set("complex:nested", data, 60_000);
      expect(await queryCache.get("complex:nested")).toEqual(data);
    });

    it("caches null values", async () => {
      await queryCache.set("complex:null", null, 60_000);
      // null is a valid cached value — should not be treated as a miss
      const result = await queryCache.get("complex:null");
      expect(result).toBeNull();
    });
  });

  describe("invalidateByPrefix edge cases", () => {
    it("does nothing when no keys match the prefix", async () => {
      await queryCache.set("keep:this", "value", 60_000);

      await queryCache.invalidateByPrefix("other:prefix.");

      expect(await queryCache.get("keep:this")).toBe("value");
    });

    it("handles empty prefix (invalidates all)", async () => {
      await queryCache.set("a:1", "val1", 60_000);
      await queryCache.set("b:2", "val2", 60_000);

      await queryCache.invalidateByPrefix("");

      expect(await queryCache.get("a:1")).toBeUndefined();
      expect(await queryCache.get("b:2")).toBeUndefined();
    });

    it("invalidates multiple keys with the same prefix", async () => {
      await queryCache.set("user1:food.byDate:2026-01-01", "d1", 60_000);
      await queryCache.set("user1:food.byDate:2026-01-02", "d2", 60_000);
      await queryCache.set("user1:food.dailyTotals:30", "d3", 60_000);
      await queryCache.set("user1:nutrition.daily:30", "d4", 60_000);

      await queryCache.invalidateByPrefix("user1:food.");

      expect(await queryCache.get("user1:food.byDate:2026-01-01")).toBeUndefined();
      expect(await queryCache.get("user1:food.byDate:2026-01-02")).toBeUndefined();
      expect(await queryCache.get("user1:food.dailyTotals:30")).toBeUndefined();
      expect(await queryCache.get("user1:nutrition.daily:30")).toBe("d4"); // not food prefix
    });
  });

  describe("sweep", () => {
    it("removes expired entries during periodic sweep", async () => {
      vi.useFakeTimers();

      try {
        // Use a fresh cache instance to control sweep interval
        // The queryCache singleton has a 5-min sweep interval
        await queryCache.set("sweep:expired1", "v1", 1000);
        await queryCache.set("sweep:expired2", "v2", 2000);
        await queryCache.set("sweep:alive", "v3", 600_000);

        // Advance past the TTL of the first two entries
        vi.advanceTimersByTime(3000);

        // Now advance to trigger the sweep (5 min = 300,000ms)
        vi.advanceTimersByTime(300_000);

        // Expired entries should be cleaned up by sweep
        expect(await queryCache.get("sweep:expired1")).toBeUndefined();
        expect(await queryCache.get("sweep:expired2")).toBeUndefined();
        // Alive entry should still be there
        expect(await queryCache.get("sweep:alive")).toBe("v3");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("overwriting existing keys", () => {
    it("overwrites value when set is called again", async () => {
      await queryCache.set("overwrite:key", "original", 60_000);
      expect(await queryCache.get("overwrite:key")).toBe("original");

      await queryCache.set("overwrite:key", "updated", 60_000);
      expect(await queryCache.get("overwrite:key")).toBe("updated");
    });

    it("resets TTL when overwriting", async () => {
      vi.useFakeTimers();

      try {
        await queryCache.set("overwrite:ttl", "original", 2000);
        vi.advanceTimersByTime(1500); // 1.5s into the 2s TTL

        // Overwrite with a new TTL
        await queryCache.set("overwrite:ttl", "refreshed", 5000);
        vi.advanceTimersByTime(3000); // 3s later — past original TTL but within new

        expect(await queryCache.get("overwrite:ttl")).toBe("refreshed");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
