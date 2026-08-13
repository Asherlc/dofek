import { formatDateYmd } from "@dofek/format/format";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { invalidateSyncedHealthData } from "./invalidate-synced-health-data";
import { runAfterUiIdle } from "./runAfterUiIdle";
import { captureException } from "./telemetry";
import { trpc } from "./trpc";

/** Check whether the latest data date is before today (stale). */
export function isDataStale(latestDate: string | null | undefined): boolean {
  if (!latestDate) return false; // No data at all — nothing to refresh
  const today = formatDateYmd();
  return latestDate < today;
}

/**
 * Auto-sync hook for the iOS overview screen.
 * When the app opens and data is stale, triggers:
 * 1. Server-side sync for all API providers (polls until complete, then invalidates cache)
 * HealthKit ingestion is owned by background-health-kit-sync so foreground startup
 * cannot launch a second copy of the same import and refetch cycle.
 */
export function useAutoSync(latestDate: string | null | undefined) {
  const isMounted = useRef(false);
  const triggered = useRef(false);
  const { mutateAsync: triggerProviderSync } = trpc.sync.triggerSync.useMutation();
  const trpcUtils = trpc.useUtils();
  const queryClient = useQueryClient();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, {
    enabled: isDataStale(latestDate),
  });

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (triggered.current) return;
    if (!isDataStale(latestDate)) return;
    if (activeSyncs.isLoading) return;
    if (activeSyncs.error) return;
    if ((activeSyncs.data?.length ?? 0) > 0) return;
    if (!latestDate) return;

    const idleHandle = runAfterUiIdle(() => {
      if (!isMounted.current || triggered.current) return;
      triggered.current = true;

      // Trigger API provider sync and poll until complete
      triggerProviderSync({ sinceDays: 1 })
        .then(async ({ jobId }: { jobId?: string }) => {
          if (!jobId) return;
          const pollUntilDone = async (): Promise<void> => {
            if (!isMounted.current) return;
            let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
            try {
              status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
            } catch (error: unknown) {
              captureException(error, { source: "auto-sync-status" });
              if (!isMounted.current) return;
              await new Promise((resolve) => setTimeout(resolve, 2000));
              if (!isMounted.current) return;
              return pollUntilDone();
            }
            if (!isMounted.current) return;
            if (!status || status.status === "completed" || status.status === "failed") {
              await invalidateSyncedHealthData(queryClient);
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
    });

    return () => {
      idleHandle.cancel();
    };
  }, [
    latestDate,
    activeSyncs.isLoading,
    activeSyncs.error,
    activeSyncs.data,
    triggerProviderSync,
    queryClient,
    trpcUtils.sync.syncStatus.fetch,
  ]);
}
