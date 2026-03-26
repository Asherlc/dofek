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
 * 1. Server-side sync for all API providers (polls until complete, then invalidates cache)
 * 2. HealthKit sync to push local health data to the server (invalidates cache on completion)
 */
export function useAutoSync(latestDate: string | null | undefined) {
  const triggered = useRef(false);
  const triggerSync = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, {
    enabled: isDataStale(latestDate),
  });

  useEffect(() => {
    if (triggered.current) return;
    if (!isDataStale(latestDate)) return;
    if (activeSyncs.isLoading) return;
    if ((activeSyncs.data?.length ?? 0) > 0) return;

    triggered.current = true;

    // Trigger API provider sync and poll until complete
    triggerSync
      .mutateAsync({ sinceDays: 1 })
      .then(async ({ jobId }) => {
        const pollUntilDone = async (): Promise<void> => {
          const status = await trpcUtils.sync.syncStatus.fetch(
            { jobId },
            { staleTime: 0 },
          );
          if (!status || status.status === "done" || status.status === "error") {
            await trpcUtils.invalidate();
            return;
          }
          await new Promise((r) => setTimeout(r, 2000));
          return pollUntilDone();
        };
        await pollUntilDone();
      })
      .catch(() => {
        // Best-effort — auto-sync is not critical
      });

    // Trigger HealthKit sync (iOS only)
    if (isAvailable()) {
      getRequestStatus()
        .then((status) => {
          if (status !== "unnecessary") return null;
          return syncHealthKitToServer({
            trpcClient: trpcUtils.client,
            healthKit: {
              queryDailyStatistics,
              queryQuantitySamples,
              queryWorkouts,
              querySleepSamples,
            },
            syncRangeDays: 1,
          });
        })
        .then((result) => {
          if (result) trpcUtils.invalidate();
        })
        .catch(() => {
          // Silently fail — auto-sync is best-effort
        });
    }
  }, [latestDate, activeSyncs.isLoading, activeSyncs.data, triggerSync, trpcUtils]);
}
