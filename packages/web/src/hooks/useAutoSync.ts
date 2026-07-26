import { formatDateYmd } from "@dofek/format/format";
import { useEffect, useRef } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc";

const autoSyncAttemptStorageKey = "dofek.dashboard.autoSyncAttempt";
const autoSyncInvalidationRetryDelayMs = 250;
const autoSyncInvalidationMaxAttempts = 2;
let fallbackAutoSyncAttemptKey: string | null = null;
let reportedSessionStorageError = false;

type InvalidatableQuery = { invalidate: () => Promise<void> };
type AutoSyncTrpcUtils = {
  recovery: { readinessScore: InvalidatableQuery };
  calendar: { activityOverview: InvalidatableQuery };
  activity: { list: InvalidatableQuery };
  processing: { status: InvalidatableQuery };
  bodyAnalytics: { weightOverview: InvalidatableQuery };
};

/** Queries refreshed after a successful dashboard auto-sync. */
export function getAutoSyncInvalidationTargets(trpcUtils: AutoSyncTrpcUtils): InvalidatableQuery[] {
  return [
    trpcUtils.recovery.readinessScore,
    trpcUtils.calendar.activityOverview,
    trpcUtils.activity.list,
    trpcUtils.processing.status,
    trpcUtils.bodyAnalytics.weightOverview,
  ];
}

export async function invalidateAutoSyncQueries(trpcUtils: AutoSyncTrpcUtils): Promise<void> {
  const invalidationTargets = getAutoSyncInvalidationTargets(trpcUtils);
  let lastError: unknown;

  for (let attempt = 1; attempt <= autoSyncInvalidationMaxAttempts; attempt++) {
    try {
      await Promise.all(invalidationTargets.map((query) => query.invalidate()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < autoSyncInvalidationMaxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, autoSyncInvalidationRetryDelayMs));
      }
    }
  }

  captureException(lastError, { context: "dashboard-auto-sync-invalidation" });
}

/** Check whether the latest data date is before today (stale). */
export function isDataStale(latestDate: string | null | undefined): boolean {
  if (!latestDate) return false; // No data at all — nothing to refresh
  return latestDate < todayYmd();
}

function todayYmd(): string {
  return formatDateYmd(new Date());
}

function autoSyncAttemptKey(latestDate: string): string {
  return `${todayYmd()}:${latestDate}`;
}

function reportSessionStorageError(error: unknown): void {
  if (reportedSessionStorageError) return;
  reportedSessionStorageError = true;
  captureException(error, { context: "dashboard-auto-sync-session-storage" });
}

function hasAttemptedAutoSyncForLatestDate(latestDate: string): boolean {
  if (typeof window === "undefined") return false;
  const expectedAttemptKey = autoSyncAttemptKey(latestDate);
  try {
    return window.sessionStorage.getItem(autoSyncAttemptStorageKey) === expectedAttemptKey;
  } catch (error) {
    reportSessionStorageError(error);
    return fallbackAutoSyncAttemptKey === expectedAttemptKey;
  }
}

function markAutoSyncAttemptedForLatestDate(latestDate: string): void {
  if (typeof window === "undefined") return;
  const attemptKey = autoSyncAttemptKey(latestDate);
  fallbackAutoSyncAttemptKey = attemptKey;
  try {
    window.sessionStorage.setItem(autoSyncAttemptStorageKey, attemptKey);
  } catch (error) {
    reportSessionStorageError(error);
  }
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
  const trpcUtils = trpc.useUtils();
  const triggerSync = trpc.sync.triggerSync.useMutation({
    onSuccess: async () => {
      await invalidateAutoSyncQueries(trpcUtils);
    },
  });
  const activeSyncs = trpc.sync.activeSyncs.useQuery(undefined, {
    enabled: dataIsStale && !attemptedForLatestDate,
  });

  useEffect(() => {
    if (triggered.current) return;
    if (!dataIsStale) return;
    if (!latestDate) return;
    if (hasAttemptedAutoSyncForLatestDate(latestDate)) return;
    if (activeSyncs.isLoading) return;
    if (activeSyncs.error) return;
    if ((activeSyncs.data?.length ?? 0) > 0) return; // sync already in progress

    triggered.current = true;
    markAutoSyncAttemptedForLatestDate(latestDate);
    triggerSync.mutate({ sinceDays: 1 });
  }, [
    latestDate,
    dataIsStale,
    activeSyncs.isLoading,
    activeSyncs.error,
    activeSyncs.data,
    triggerSync,
  ]);
}
