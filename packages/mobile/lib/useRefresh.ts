import { useCallback, useState } from "react";
import { captureException } from "./telemetry";
import { trpc } from "./trpc";

type RefreshTask = () => Promise<void> | void;

interface UseRefreshOptions {
  refresh?: RefreshTask;
  invalidate?: RefreshTask | null;
}

/**
 * Pull-to-refresh hook. Starts a background tRPC cache invalidation and
 * optionally runs an extra callback (e.g. trigger server sync).
 */
export function useRefresh(input?: RefreshTask | UseRefreshOptions): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const utils = trpc.useUtils();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = typeof input === "function" ? input : input?.refresh;
  const invalidate =
    typeof input === "function" || input?.invalidate === undefined
      ? () => utils.invalidate()
      : input.invalidate;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (invalidate != null) {
      void Promise.resolve()
        .then(() => invalidate())
        .catch((error: unknown) => {
          captureException(error, { source: "useRefresh.invalidate" });
        });
    }

    try {
      await Promise.resolve()
        .then(() => refresh?.())
        .catch((error: unknown) => {
          captureException(error, { source: "useRefresh" });
        });
    } finally {
      setRefreshing(false);
    }
  }, [invalidate, refresh]);

  return { refreshing, onRefresh };
}
