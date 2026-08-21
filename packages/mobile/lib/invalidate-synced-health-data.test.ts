import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateSyncedHealthData } from "./invalidate-synced-health-data";

describe("invalidateSyncedHealthData", () => {
  it("invalidates only query families derived from synchronized health data", async () => {
    const queryClient = new QueryClient();
    const syncedKeys = [
      [["mobileDashboard", "dashboardV2"], { type: "query" }],
      [["mobileDashboard", "recovery"], { type: "query" }],
      [["mobileDashboard", "training"], { type: "query" }],
      [["calendar", "weekList"], { type: "query" }],
      [["calendar", "activityOverview"], { type: "query" }],
      [["activity", "list"], { type: "query" }],
      [["food", "byDateV2"], { type: "query" }],
      [["processing", "status"], { type: "query" }],
      [["nutritionAnalytics", "adaptiveTdee"], { type: "query" }],
      [["nutritionAnalytics", "macroRatios"], { type: "query" }],
      [["nutritionAnalytics", "micronutrientAdequacyV2"], { type: "query" }],
    ];
    const unrelatedKey = [["settings", "get"], { type: "query" }];

    for (const queryKey of syncedKeys) {
      queryClient.setQueryData(queryKey, "synced");
    }
    queryClient.setQueryData(unrelatedKey, "unrelated");

    await invalidateSyncedHealthData(queryClient);

    for (const queryKey of syncedKeys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  });
});
