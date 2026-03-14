import { describe, expect, it } from "vitest";
import { queryCache } from "./cache.ts";

describe("MemoryCacheStore", () => {
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

    // Clean up
    await queryCache.invalidateAll();
  });
});
