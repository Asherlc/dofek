import type { QueryClient } from "@tanstack/react-query";

const SYNCED_HEALTH_DATA_QUERY_PATHS = new Set([
  "mobileDashboard.dashboardV2",
  "mobileDashboard.recovery",
  "mobileDashboard.training",
  "calendar.weekList",
  "calendar.activityOverview",
  "activity.list",
  "food.byDateV2",
  "processing.status",
  "nutritionAnalytics.adaptiveTdee",
  "nutritionAnalytics.macroRatios",
  "nutritionAnalytics.micronutrientAdequacyV2",
]);

function queryPath(queryKey: readonly unknown[]): string | null {
  const path = queryKey[0];
  if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) {
    return null;
  }
  return path.join(".");
}

/** Refresh only client queries whose results can change after health-data synchronization. */
export async function invalidateSyncedHealthData(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) => {
      const path = queryPath(query.queryKey);
      return path !== null && SYNCED_HEALTH_DATA_QUERY_PATHS.has(path);
    },
  });
}
