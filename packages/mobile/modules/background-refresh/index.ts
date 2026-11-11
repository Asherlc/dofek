import type { EventSubscription } from "expo";
import { captureException, captureTelemetrySessionGuard } from "../../lib/telemetry";
import BackgroundRefreshModule, {
  type BackgroundRefreshDiagnosticHistory,
  type BackgroundRefreshEvent,
} from "./src/BackgroundRefreshModule";

export type {
  BackgroundRefreshDiagnosticEvent,
  BackgroundRefreshDiagnosticHistory,
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
