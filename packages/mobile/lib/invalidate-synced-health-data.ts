import type { QueryClient } from "@tanstack/react-query";

const HEALTH_SYNC_INITIAL_FETCH_PATHS = new Set([
  "activity.byId",
  "cycling.decoupling",
  "climbing.volumeIncrease",
  "climbing.attemptIncrease",
  "climbing.bestOnsight",
  "trainingProgression.strength",
  "trainingProgression.cycling",
  "insights.compute",
]);

const SYNCED_HEALTH_DATA_QUERY_PATHS = new Set([
  "mobileDashboard.dashboardV2",
  "mobileDashboard.recovery",
  "mobileDashboard.trainingV2",
  ...HEALTH_SYNC_INITIAL_FETCH_PATHS,
  "calendar.weekListV2",
  "calendar.activityOverview",
  "calendar.upcomingWorkouts",
  "activity.list",
  "food.byDateV2",
  "processing.status",
  "dailyMetrics.recorded",
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
        query.state.data === undefined && path !== null && HEALTH_SYNC_INITIAL_FETCH_PATHS.has(path)
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
