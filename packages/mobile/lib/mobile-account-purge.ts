import { ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE } from "@dofek/auth/account-erasure";
import type { QueryClient } from "@tanstack/react-query";
import { purgeAccountState as purgeHeartRateAccountState } from "../modules/ble-heart-rate";
import { purgeAccountState as purgeCoreMotionAccountState } from "../modules/core-motion";
import {
  deleteDietarySamples,
  purgeAccountState as purgeHealthKitAccountState,
} from "../modules/health-kit";
import { purgeAccountState as purgeWatchMotionAccountState } from "../modules/watch-motion";
import { purgeAccountState as purgeWhoopBleAccountState } from "../modules/whoop-ble";
import { clearMobileAccountErasurePreparation } from "./account-erasure-storage";
import { clearSessionToken } from "./auth";
import type { AccountErasureCleanupLease } from "./auth-context";
import { teardownBackgroundAccelerometerSync } from "./background-accelerometer-sync";
import { teardownBackgroundHealthKitSync } from "./background-health-kit-sync";
import { teardownBackgroundWatchInertialMeasurementUnitSync } from "./background-watch-inertial-measurement-unit-sync";
import { teardownBackgroundWhoopBleSync } from "./background-whoop-ble-sync";
import { clearPendingMobileBillingCheckoutOperation } from "./billing-checkout-operation";
import { advanceDeviceErasureCutoff } from "./device-erasure-cutoff";
import { purgeDofekFoodWriteBackFromHealthKit } from "./health-kit-food-writeback";
import { purgeScheduledMedicationReminderNotifications } from "./medication-reminder-notifications";
import { purgeMobileExportCache } from "./mobile-export-cache";
import { removeAllMobileQueryCaches } from "./mobile-query-persistence";
import { captureException } from "./telemetry";

interface MobileAccountPurgeDependencies {
  advanceErasureCutoff(candidate: string): Promise<string>;
  clearBillingCheckoutOperation(): Promise<unknown>;
  clearPreparation(): Promise<unknown>;
  clearSession(): Promise<unknown>;
  purgeCoreMotion(cutoff: string): Promise<unknown>;
  purgeExportCache(): unknown;
  purgeFoodWriteBack(): Promise<unknown>;
  purgeHealthKitState(cutoff: string): Promise<unknown>;
  purgeHeartRate(cutoff: string): Promise<unknown>;
  purgeMedicationReminders(): Promise<unknown>;
  purgeQueryCaches(): Promise<unknown>;
  purgeWatchMotion(cutoff: string): Promise<unknown>;
  purgeWhoopBle(cutoff: string): Promise<unknown>;
  teardownAccelerometer(): void;
  teardownHealthKit(): void;
  teardownWatchMotion(): void;
  teardownWhoopBle(): void;
}

const defaultDependencies: MobileAccountPurgeDependencies = {
  advanceErasureCutoff: advanceDeviceErasureCutoff,
  clearBillingCheckoutOperation: clearPendingMobileBillingCheckoutOperation,
  clearPreparation: clearMobileAccountErasurePreparation,
  clearSession: clearSessionToken,
  purgeCoreMotion: purgeCoreMotionAccountState,
  purgeExportCache: purgeMobileExportCache,
  purgeFoodWriteBack: () =>
    purgeDofekFoodWriteBackFromHealthKit({
      healthKit: { deleteDietarySamples },
    }),
  purgeHealthKitState: purgeHealthKitAccountState,
  purgeHeartRate: purgeHeartRateAccountState,
  purgeMedicationReminders: purgeScheduledMedicationReminderNotifications,
  purgeQueryCaches: removeAllMobileQueryCaches,
  purgeWatchMotion: purgeWatchMotionAccountState,
  purgeWhoopBle: purgeWhoopBleAccountState,
  teardownAccelerometer: teardownBackgroundAccelerometerSync,
  teardownHealthKit: teardownBackgroundHealthKitSync,
  teardownWatchMotion: teardownBackgroundWatchInertialMeasurementUnitSync,
  teardownWhoopBle: teardownBackgroundWhoopBleSync,
};

export interface MobileAccountPurgeResult {
  errors: Error[];
}

export async function purgeMobileAccountState({
  cleanupLease,
  cutoff = new Date().toISOString(),
  dependencies = defaultDependencies,
  isCleanupLeaseCurrent,
  queryClient,
}: {
  cleanupLease: AccountErasureCleanupLease;
  cutoff?: string;
  dependencies?: MobileAccountPurgeDependencies;
  isCleanupLeaseCurrent: (lease: AccountErasureCleanupLease) => boolean;
  queryClient: Pick<QueryClient, "clear"> | { clear(): void };
}): Promise<MobileAccountPurgeResult> {
  const errors: Error[] = [];
  let ownershipFailureReported = false;
  const canContinue = (): boolean => {
    if (isCleanupLeaseCurrent(cleanupLease)) return true;
    if (!ownershipFailureReported) {
      ownershipFailureReported = true;
      errors.push(new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE));
      captureException(new Error("Local account erasure cleanup ownership changed."), {
        source: "account-erasure-cleanup-ownership",
      });
    }
    return false;
  };
  const attempt = async (source: string, operation: () => unknown | Promise<unknown>) => {
    if (!canContinue()) return;
    try {
      await operation();
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      errors.push(normalized);
      captureException(new Error("Local account erasure cleanup failed."), {
        source,
      });
    }
  };

  let effectiveCutoff = cutoff;
  if (!canContinue()) return { errors };
  try {
    effectiveCutoff = await dependencies.advanceErasureCutoff(cutoff);
  } catch (error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    errors.push(normalized);
    captureException(new Error("Local account erasure cleanup failed."), {
      source: "account-erasure-cutoff-persist",
    });
  }

  await attempt("account-erasure-stop-health-kit", dependencies.teardownHealthKit);
  await attempt("account-erasure-stop-core-motion", dependencies.teardownAccelerometer);
  await attempt("account-erasure-stop-watch-motion", dependencies.teardownWatchMotion);
  await attempt("account-erasure-stop-whoop-ble", dependencies.teardownWhoopBle);

  await attempt("account-erasure-healthkit-food-purge", dependencies.purgeFoodWriteBack);
  await attempt("account-erasure-healthkit-state-purge", () =>
    dependencies.purgeHealthKitState(effectiveCutoff),
  );
  await attempt("account-erasure-core-motion-purge", () =>
    dependencies.purgeCoreMotion(effectiveCutoff),
  );
  await attempt("account-erasure-watch-motion-purge", () =>
    dependencies.purgeWatchMotion(effectiveCutoff),
  );
  await attempt("account-erasure-whoop-ble-purge", () =>
    dependencies.purgeWhoopBle(effectiveCutoff),
  );
  await attempt("account-erasure-heart-rate-purge", () =>
    dependencies.purgeHeartRate(effectiveCutoff),
  );
  await attempt(
    "account-erasure-medication-reminders-purge",
    dependencies.purgeMedicationReminders,
  );
  await attempt("account-erasure-export-cache-purge", dependencies.purgeExportCache);
  await attempt("account-erasure-query-persistence-purge", dependencies.purgeQueryCaches);
  await attempt(
    "account-erasure-billing-checkout-purge",
    dependencies.clearBillingCheckoutOperation,
  );
  await attempt("account-erasure-session-purge", dependencies.clearSession);
  await attempt("account-erasure-preparation-purge", dependencies.clearPreparation);
  await attempt("account-erasure-query-memory-purge", () => queryClient.clear());

  return { errors };
}
