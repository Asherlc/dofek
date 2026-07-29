import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";

function subscribeToOnlineStatus(onStoreChange: () => void) {
  return onlineManager.subscribe(onStoreChange);
}

function getOnlineStatus(): boolean {
  return onlineManager.isOnline();
}

function getErrorMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  const trimmedMessage = message?.trim();
  return trimmedMessage ? trimmedMessage : null;
}

function useActiveQueryFailureCount(): number {
  const queryClient = useQueryClient();
  const queryCache = queryClient.getQueryCache();
  const subscribe = useCallback(
    (onStoreChange: () => void) => queryCache.subscribe(onStoreChange),
    [queryCache],
  );
  const getSnapshot = useCallback(
    () =>
      queryCache.findAll({ type: "active" }).filter((query) => query.state.error !== null).length,
    [queryCache],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useSingleActiveQueryFailureMessage(): string | null {
  const queryClient = useQueryClient();
  const queryCache = queryClient.getQueryCache();
  const subscribe = useCallback(
    (onStoreChange: () => void) => queryCache.subscribe(onStoreChange),
    [queryCache],
  );
  const getSnapshot = useCallback(() => {
    const failedQueries = queryCache
      .findAll({ type: "active" })
      .filter((query) => query.state.error !== null);
    return failedQueries.length === 1 ? getErrorMessage(failedQueries[0]?.state.error) : null;
  }, [queryCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function DataConnectionBanner() {
  const queryClient = useQueryClient();
  const isOnline = useSyncExternalStore(subscribeToOnlineStatus, getOnlineStatus, getOnlineStatus);
  const activeFailureCount = useActiveQueryFailureCount();
  const activeFailureMessage = useSingleActiveQueryFailureMessage();
  const [isRetrying, setIsRetrying] = useState(false);
  const isRetryingRef = useRef(false);

  if (isOnline && activeFailureCount === 0 && !isRetrying) {
    return null;
  }

  const message = isOnline
    ? activeFailureMessage
      ? `${activeFailureMessage} — showing last available data where available.`
      : "Data refresh failed — showing last available data where available."
    : "Offline — showing last available data where available. It may be stale until you reconnect.";
  const retryLabel = isOnline
    ? isRetrying
      ? "Retrying..."
      : "Retry"
    : "Retry unavailable offline";
  const retryFailedQueries = async () => {
    if (isRetryingRef.current) {
      return;
    }
    isRetryingRef.current = true;
    setIsRetrying(true);
    try {
      await queryClient.refetchQueries({
        type: "active",
        predicate: (query) => query.state.error !== null,
      });
    } finally {
      isRetryingRef.current = false;
      setIsRetrying(false);
    }
  };

  return (
    <output
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-700/30 bg-amber-100/80 px-3 py-2 text-amber-950 sm:px-6"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium sm:text-sm">{message}</p>
        <button
          type="button"
          disabled={!isOnline || isRetrying}
          onClick={() => void retryFailedQueries()}
          className="rounded-md border border-amber-800/30 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {retryLabel}
        </button>
      </div>
    </output>
  );
}
