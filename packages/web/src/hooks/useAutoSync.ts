import { useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";

/** Check whether the latest data date is before today (stale). */
export function isDataStale(latestDate: string | null | undefined): boolean {
  if (!latestDate) return false; // No data at all — nothing to refresh
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
  return latestDate < today;
}

/**
 * Auto-sync hook for the web dashboard.
 * When the dashboard loads and the most recent data is from a previous day,
 * triggers a server-side sync for all connected API providers.
 *
 * HealthKit data can only be pushed from the iOS app, so this hook only
 * handles API-based providers (Strava, Wahoo, Whoop, etc.).
 */
export function useAutoSync(latestDate: string | null | undefined) {
  const triggered = useRef(false);
  const triggerSync = trpc.sync.triggerSync.useMutation();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, {
    enabled: isDataStale(latestDate),
  });

  useEffect(() => {
    if (triggered.current) return;
    if (!isDataStale(latestDate)) return;
    if (activeSyncs.isLoading) return;
    if ((activeSyncs.data?.length ?? 0) > 0) return; // sync already in progress

    triggered.current = true;
    triggerSync.mutate({ sinceDays: 1 });
  }, [latestDate, activeSyncs.isLoading, activeSyncs.data, triggerSync]);
}
