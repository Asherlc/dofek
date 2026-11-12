import type { EventSubscription } from "expo";
import { captureException, captureTelemetrySessionGuard } from "../../lib/telemetry";
import BackgroundRefreshModule, {
  type BackgroundRefreshDiagnosticHistory,
  type BackgroundRefreshEvent,
  type HealthKitSyncExpiredEvent,
  type HealthKitSyncStartResult,
} from "./src/BackgroundRefreshModule";

export type {
  BackgroundRefreshDiagnosticEvent,
  BackgroundRefreshDiagnosticHistory,
  HealthKitSyncExpiredEvent,
  HealthKitSyncStartResult,
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

/** Enable native alerts using existing authorization; request permission only in the foreground. */
export function enableCollectionNotifications(requestPermission: boolean): Promise<boolean> {
  return BackgroundRefreshModule.enableCollectionNotifications(requestPermission);
}

/** Cancel both alerts when the authenticated session or background collection ends. */
export function disableCollectionNotifications(): void {
  BackgroundRefreshModule.disableCollectionNotifications();
}

/** Nondestructive native history. Validate at the telemetry boundary before use. */
export function getDiagnostics(): BackgroundRefreshDiagnosticHistory {
  return BackgroundRefreshModule.getDiagnostics();
}

/** Mark JavaScript receipt before work begins. */
export function recordRefreshReceived(taskId: string): void {
  BackgroundRefreshModule.recordRefreshReceived(taskId);
}

/** Erase retained device history during account cleanup. */
export function clearDiagnostics(): void {
  BackgroundRefreshModule.clearDiagnostics();
}

/** Start the native continued-processing lifetime for one manual Apple Health sync.
 * Resolves with `supported: false` on iOS versions that cannot provide it.
 *
 * The listener generation is snapshotted synchronously here, before the native
 * `AsyncFunction` is dispatched. Expo queues that body, so a subscription removed
 * and re-added while it is queued must not adopt the invocation; the native side
 * validates this exact generation instead of reading the live one. */
export async function startHealthKitSync(taskId: string): Promise<HealthKitSyncStartResult> {
  const listenerGeneration = BackgroundRefreshModule.getHealthKitSyncListenerGeneration();
  if (listenerGeneration === null) {
    throw new Error(
      "Apple Health sync requires an active expiration listener owned by this app session.",
    );
  }
  return BackgroundRefreshModule.startHealthKitSync(taskId, listenerGeneration);
}

/** Report completed sync stages as native task progress and subtitle. */
export function updateHealthKitSyncProgress(
  taskId: string,
  completed: number,
  total: number,
  message: string,
): void {
  BackgroundRefreshModule.updateHealthKitSyncProgress(taskId, completed, total, message);
}

/** Complete the native task at most once after the sync work settles. */
export function completeHealthKitSync(taskId: string, success: boolean): void {
  BackgroundRefreshModule.completeHealthKitSync(taskId, success);
}

/** Listen for native expiration or cancellation of the manual sync task. */
export function addHealthKitSyncExpirationListener(
  callback: (event: HealthKitSyncExpiredEvent) => void,
): EventSubscription {
  const isCurrentSession = captureTelemetrySessionGuard();
  return BackgroundRefreshModule.addListener("onHealthKitSyncExpired", ({ taskId }) => {
    try {
      callback({ taskId });
    } catch (error: unknown) {
      captureException(error, {
        source: "health-kit-sync-expiration",
        taskId,
        ...(!isCurrentSession() ? { retiredLifetime: true } : {}),
      });
    }
  });
}

/** Listen for refresh wakeups and complete native work only after the handler settles. */
export function addBackgroundRefreshListener(
  callback: () => Promise<void>,
  reportDiagnostics: (trigger: "received" | "settled") => void,
): EventSubscription {
  const isCurrentSession = captureTelemetrySessionGuard();
  const diagnose = (source: string, operation: () => void): void => {
    try {
      operation();
    } catch (error: unknown) {
      captureException(error, {
        source,
        ...(!isCurrentSession() ? { retiredLifetime: true } : {}),
      });
    }
  };
  return BackgroundRefreshModule.addListener(
    "onBackgroundRefresh",
    ({ taskId }: BackgroundRefreshEvent) => {
      diagnose("background-refresh-received", () => recordRefreshReceived(taskId));
      diagnose("background-refresh-diagnostics-received", () => reportDiagnostics("received"));
      const complete = (success: boolean): void => {
        diagnose("background-refresh-completion", () =>
          BackgroundRefreshModule.completeRefresh(taskId, success),
        );
        diagnose("background-refresh-diagnostics-settled", () => reportDiagnostics("settled"));
      };
      void Promise.resolve()
        .then(callback)
        .then(
          () => complete(true),
          (error: unknown) => {
            captureException(error, {
              source: "background-refresh-handler",
              ...(!isCurrentSession() ? { retiredLifetime: true } : {}),
            });
            complete(false);
          },
        );
    },
  );
}
