import { readImuConnectionBinding } from "./imu-connection-storage.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { drainPhoneHealthOutbox, type PostHealthEnvelope } from "./phone-health-sync.ts";
import { LegacyImuAccountBindingRequiredError } from "./phone-imu-outbox.ts";
import { drainPhoneImuOutbox, type PostImuEnvelope } from "./phone-imu-sync.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { SyncCoordinator } from "./sync-coordinator.ts";

interface CoordinatorDependencies {
  getStorage(): SettingsStorage;
  setStatus(payload: Record<string, unknown>): void;
  report(error: unknown, context: Record<string, unknown>): void;
  retryBaseDelayMs: number;
  maxRetryAttempts: number;
}

export function createPhoneHealthSyncCoordinator(
  dependencies: CoordinatorDependencies & { post: PostHealthEnvelope },
): SyncCoordinator {
  return new SyncCoordinator(
    async (reasons) => {
      dependencies.setStatus({ state: "syncing", reasons });
      try {
        const storage = dependencies.getStorage();
        const result = await drainPhoneHealthOutbox(storage, dependencies.post);
        storage.setItem(STORAGE_KEYS.LAST_HEALTH_SYNC, String(Date.now()));
        dependencies.setStatus({ state: "done", ...result });
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Health data upload failed.";
        dependencies.report(error, { category: "health-upload", reasons });
        dependencies.setStatus({ state: "error", reason });
        return false;
      }
    },
    {
      retryBaseDelayMs: dependencies.retryBaseDelayMs,
      maxRetryAttempts: dependencies.maxRetryAttempts,
      onRetryError: (error) => dependencies.report(error, { category: "health-upload-retry" }),
    },
  );
}

export function createPhoneImuSyncCoordinator(
  dependencies: CoordinatorDependencies & { post: PostImuEnvelope },
): SyncCoordinator {
  return new SyncCoordinator(
    async (reasons) => {
      dependencies.setStatus({ state: "syncing", reasons });
      try {
        const storage = dependencies.getStorage();
        const result = await drainPhoneImuOutbox(
          storage,
          readImuConnectionBinding(storage),
          dependencies.post,
        );
        dependencies.setStatus(
          result.quarantined > 0
            ? {
                state: "error",
                ...result,
                reason: `${result.quarantined} motion recording${result.quarantined === 1 ? " needs" : "s need"} recovery. Contact support before deleting app data.`,
              }
            : { state: "done", ...result },
        );
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "IMU data upload failed.";
        dependencies.report(error, { category: "imu-upload", reasons });
        dependencies.setStatus({
          state: "error",
          reason,
          ...(error instanceof LegacyImuAccountBindingRequiredError
            ? { requiresAccountBinding: true }
            : {}),
        });
        return false;
      }
    },
    {
      retryBaseDelayMs: dependencies.retryBaseDelayMs,
      maxRetryAttempts: dependencies.maxRetryAttempts,
      onRetryError: (error) => dependencies.report(error, { category: "imu-upload-retry" }),
    },
  );
}
