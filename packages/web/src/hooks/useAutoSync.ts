import { useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";

const autoSyncAttemptedLatestDateStorageKey = "dofek.dashboard.autoSyncAttemptedLatestDate";

/** Check whether the latest data date is before today (stale). */
export function isDataStale(latestDate: string | null | undefined): boolean {
  if (!latestDate) return false; // No data at all — nothing to refresh
  return latestDate < todayYmd();
}

function todayYmd(): string {
  return new Date().toLocaleDateString("en-CA");
}

function hasAttemptedAutoSyncForLatestDate(latestDate: string): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(autoSyncAttemptedLatestDateStorageKey) === latestDate;
}

function markAutoSyncAttemptedForLatestDate(latestDate: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(autoSyncAttemptedLatestDateStorageKey, latestDate);
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
  const dataIsStale = isDataStale(latestDate);
  const attemptedForLatestDate = latestDate ? hasAttemptedAutoSyncForLatestDate(latestDate) : false;
  const triggerSync = trpc.sync.triggerSync.useMutation();
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, {
    enabled: dataIsStale && !attemptedForLatestDate,
  });

  useEffect(() => {
    if (triggered.current) return;
    if (!dataIsStale) return;
    if (!latestDate) return;
    if (hasAttemptedAutoSyncForLatestDate(latestDate)) return;
    if (activeSyncs.isLoading) return;
    if ((activeSyncs.data?.length ?? 0) > 0) return; // sync already in progress

    triggered.current = true;
    markAutoSyncAttemptedForLatestDate(latestDate);
    triggerSync.mutate({ sinceDays: 1 });
  }, [latestDate, dataIsStale, activeSyncs.isLoading, activeSyncs.data, triggerSync]);
}
