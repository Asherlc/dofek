import { useEffect, useRef } from "react";
import {
  getRequestStatus,
  isAvailable,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkouts,
} from "../modules/health-kit";
import { syncHealthKitToServer } from "./health-kit-sync";
import { captureException, logger } from "./telemetry";
import { trpc } from "./trpc";

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
          const status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
          if (!status || status.status === "done" || status.status === "error") {
            await trpcUtils.invalidate();
            return;
          }
          await new Promise((r) => setTimeout(r, 2000));
          return pollUntilDone();
        };
        await pollUntilDone();
      })
      .catch((error: unknown) => {
        // Best-effort — auto-sync is not critical
        captureException(error, { source: "auto-sync-providers" });
      });

    // Trigger HealthKit sync (iOS only)
    if (isAvailable()) {
      logger.info("auto-sync", "Starting HealthKit sync");
      getRequestStatus()
        .then((status) => {
          if (status !== "unnecessary") {
            logger.info("auto-sync", `HealthKit permission status="${status}", skipping`);
            return null;
          }
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
          if (result) {
            logger.info(
              "auto-sync",
              `HealthKit sync complete: ${result.inserted} inserted, ${result.errors.length} errors`,
            );
            trpcUtils.invalidate();
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            "auto-sync",
            `HealthKit sync failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          captureException(error, { source: "auto-sync-healthkit" });
        });
    }
  }, [latestDate, activeSyncs.isLoading, activeSyncs.data, triggerSync, trpcUtils]);
}
