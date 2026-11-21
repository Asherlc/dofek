import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invalidateSyncedHealthData } from "./invalidate-synced-health-data";

describe("invalidateSyncedHealthData", () => {
  it.each([
    ["climbing", "volumeIncrease"],
    ["climbing", "attemptIncrease"],
    ["activity", "byId"],
  ])(
    "refreshes %s.%s when its first fetch overlaps a completed sync",
    async (router, procedure) => {
      const queryClient = new QueryClient();
      const queryKey = [[router, procedure], { type: "query" }];
      const initial = Promise.withResolvers<string>();
      const queryFn = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue("after sync");
      const observer = new QueryObserver(queryClient, { queryKey, queryFn });
      const unsubscribe = observer.subscribe(() => {});

      try {
        expect(observer.getCurrentResult()).toMatchObject({ data: undefined, isFetching: true });
        const refresh = invalidateSyncedHealthData(queryClient);
        initial.resolve("before sync");
        await refresh;

        expect(queryFn).toHaveBeenCalledTimes(2);
        expect(observer.getCurrentResult().data).toBe("after sync");
      } finally {
        unsubscribe();
        queryClient.clear();
      }
    },
  );

  it("invalidates only query families derived from synchronized health data", async () => {
    const queryClient = new QueryClient();
    const syncedKeys = [
      [["mobileDashboard", "dashboardV2"], { type: "query" }],
      [["mobileDashboard", "recovery"], { type: "query" }],
      [["mobileDashboard", "trainingV2"], { type: "query" }],
      [["climbing", "volumeIncrease"], { type: "query" }],
      [["climbing", "attemptIncrease"], { type: "query" }],
      [["calendar", "weekListV2"], { type: "query" }],
      [["calendar", "activityOverview"], { type: "query" }],
      [["activity", "list"], { type: "query" }],
      [["activity", "byId"], { input: { id: "ride" }, type: "query" }],
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
