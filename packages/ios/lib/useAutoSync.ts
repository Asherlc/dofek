import { useEffect, useRef } from "react";
import { trpc } from "./trpc";
import {
  getRequestStatus,
  isAvailable,
  queryDailyStatistics,
  queryQuantitySamples,
  queryWorkouts,
  querySleepSamples,
} from "../modules/health-kit";
import { syncHealthKitToServer } from "./health-kit-sync";

/** Check whether the latest data date is before today (stale). */
export function isDataStale(latestDate: string | null | undefined): boolean {
  if (!latestDate) return false; // No data at all — nothing to refresh
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
  return latestDate < today;
}

/**
 * Auto-sync hook for the iOS overview screen.
 * When the app opens and data is stale, triggers:
 * 1. Server-side sync for all API providers
 * 2. HealthKit sync to push local health data to the server
 */
export function useAutoSync(latestDate: string | null | undefined) {
  const triggered = useRef(false);
  const triggerSync = trpc.sync.triggerSync.useMutation();
  const trpcClient = trpc.useUtils().client;
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, {
    enabled: isDataStale(latestDate),
  });

  useEffect(() => {
    if (triggered.current) return;
    if (!isDataStale(latestDate)) return;
    if (activeSyncs.isLoading) return;
    if ((activeSyncs.data?.length ?? 0) > 0) return;

    triggered.current = true;

    // Trigger API provider sync
    triggerSync.mutate({ sinceDays: 1 });

    // Trigger HealthKit sync (iOS only)
    if (isAvailable()) {
      getRequestStatus()
        .then((status) => {
          if (status !== "unnecessary") return;
          return syncHealthKitToServer({
            trpcClient,
            healthKit: {
              queryDailyStatistics,
              queryQuantitySamples,
              queryWorkouts,
              querySleepSamples,
            },
            syncRangeDays: 1,
          });
        })
        .catch(() => {
          // Silently fail — auto-sync is best-effort
        });
    }
  }, [latestDate, activeSyncs.isLoading, activeSyncs.data, triggerSync, trpcClient]);
}
