import { formatDateYmd } from "@dofek/format/format";
import { useEffect, useRef } from "react";
import { InteractionManager } from "react-native";
import { deleteDietarySamples, writeDietarySamples } from "../modules/health-kit";
import { AppleHealthAuthorizationService, AppleHealthSyncService } from "./apple-health-provider";
import { syncDofekFoodToHealthKit } from "./health-kit-food-writeback";
import { captureException, logger } from "./telemetry";
import { trpc } from "./trpc";

/** Check whether the latest data date is before today (stale). */
export function isDataStale(latestDate: string | null | undefined): boolean {
  if (!latestDate) return false; // No data at all — nothing to refresh
  const today = formatDateYmd();
  return latestDate < today;
}

function todayYmd(): string {
  return formatDateYmd();
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
    if (!latestDate) return;

    const interactionHandle = InteractionManager.runAfterInteractions(() => {
      if (triggered.current) return;
      triggered.current = true;

      // Trigger API provider sync and poll until complete
      triggerSync
        .mutateAsync({ sinceDays: 1 })
        .then(async ({ jobId }: { jobId?: string }) => {
          if (!jobId) return;
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
      const appleHealthAuthorization = new AppleHealthAuthorizationService();
      const appleHealthSync = new AppleHealthSyncService({ trpcClient: trpcUtils.client });
      void appleHealthAuthorization
        .resolve()
        .then((authorizationState) => {
          if (!authorizationState.canAttemptSync()) {
            return null;
          }
          logger.info("auto-sync", "Starting HealthKit sync");
          return appleHealthSync.sync({ syncRangeDays: 1 });
        })
        .then(async (result) => {
          if (!result) {
            return;
          }
          await syncDofekFoodToHealthKit({
            trpcClient: trpcUtils.client,
            healthKit: {
              writeDietarySamples,
              deleteDietarySamples,
            },
            startDate: latestDate,
            endDate: todayYmd(),
          });
          logger.info(
            "auto-sync",
            `HealthKit sync complete: ${result.inserted} inserted, ${result.errors.length} errors`,
          );
          await trpcUtils.invalidate();
        })
        .catch((error: unknown) => {
          logger.warn(
            "auto-sync",
            `HealthKit sync failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          captureException(error, { source: "auto-sync-healthkit" });
        });
    });

    return () => {
      interactionHandle.cancel();
    };
  }, [latestDate, activeSyncs.isLoading, activeSyncs.data, triggerSync, trpcUtils]);
}
