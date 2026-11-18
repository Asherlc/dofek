import type { QueryClient } from "@tanstack/react-query";

const CLIMBING_ALERT_QUERY_PATHS = new Set(["climbing.volumeIncrease", "climbing.attemptIncrease"]);

const SYNCED_HEALTH_DATA_QUERY_PATHS = new Set([
  "mobileDashboard.dashboardV2",
  "mobileDashboard.recovery",
  "mobileDashboard.trainingV2",
  ...CLIMBING_ALERT_QUERY_PATHS,
  "calendar.weekListV2",
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
  // Invalidation reuses in-flight initial requests, which may have read pre-sync data.
  await queryClient.cancelQueries({
    type: "active",
    fetchStatus: "fetching",
    predicate: (query) => {
      const path = queryPath(query.queryKey);
      return (
        query.state.data === undefined && path !== null && CLIMBING_ALERT_QUERY_PATHS.has(path)
      );
    },
  });

  await queryClient.invalidateQueries({
    predicate: (query) => {
      const path = queryPath(query.queryKey);
      return path !== null && SYNCED_HEALTH_DATA_QUERY_PATHS.has(path);
    },
  });
}
