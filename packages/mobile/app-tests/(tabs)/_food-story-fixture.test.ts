import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { seedFoodStoryQuery } from "../../app-fixtures/(tabs)/food-story-fixture";
import { FoodByDateV2Schema } from "../../types/api";

describe("seedFoodStoryQuery", () => {
  it("seeds runtime-valid data for the current byDateV2 procedure", () => {
    const queryClient = new QueryClient();
    const date = "2026-07-27";

    seedFoodStoryQuery(queryClient, date);

    const data = queryClient.getQueryData([
      ["food", "byDateV2"],
      { input: { date }, type: "query" },
    ]);
    expect(FoodByDateV2Schema.safeParse(data).success).toBe(true);
    expect(
      queryClient.getQueryData([["food", "byDate"], { input: { date }, type: "query" }]),
    ).toBeUndefined();
  });
});
