import { useCallback, useState } from "react";
import { trpc } from "./trpc";

/**
 * Pull-to-refresh hook. Invalidates all active tRPC queries on the current
 * screen and optionally runs an extra callback (e.g. trigger server sync).
 */
export function useRefresh(
  extra?: () => Promise<void> | void,
): { refreshing: boolean; onRefresh: () => void } {
  const utils = trpc.useUtils();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        utils.invalidate(),
        Promise.resolve(extra?.()).catch(() => {}),
      ]);
    } catch {
      // invalidate() failure — still stop spinner
    } finally {
      setRefreshing(false);
    }
  }, [utils, extra]);

  return { refreshing, onRefresh };
}
