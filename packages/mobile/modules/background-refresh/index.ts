import type { EventSubscription } from "expo-modules-core";
import BackgroundRefreshModule, {
  type BackgroundRefreshEvent,
} from "./src/BackgroundRefreshModule";

/** Schedule the next background refresh wakeup.
 * Call this after completing background work so the system
 * knows to wake us again. */
export function scheduleRefresh(): void {
  BackgroundRefreshModule.scheduleRefresh();
}

/** Check if background app refresh is available.
 * Returns false if the user has disabled it in iOS Settings. */
export function isBackgroundRefreshAvailable(): boolean {
  return BackgroundRefreshModule.isAvailable();
}

/** Listen for background refresh wakeups and bridge the settled handler result
 * back to the matching native BGAppRefreshTask. */
export function addBackgroundRefreshListener(callback: () => Promise<void>): EventSubscription {
  return BackgroundRefreshModule.addListener(
    "onBackgroundRefresh",
    ({ taskId }: BackgroundRefreshEvent) => {
      void Promise.resolve()
        .then(callback)
        .then(
          () => BackgroundRefreshModule.completeRefresh(taskId, true),
          () => BackgroundRefreshModule.completeRefresh(taskId, false),
        );
    },
  );
}
