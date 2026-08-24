import { describe, expect, it, vi } from "vitest";
import { purgeMobileAccountState } from "./mobile-account-purge";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

vi.mock("./billing-checkout-operation", () => ({
  clearPendingMobileBillingCheckoutOperation: vi.fn(),
}));

vi.mock("./mobile-export-cache", () => ({
  purgeMobileExportCache: vi.fn(),
}));

describe("purgeMobileAccountState", () => {
  const cleanupLease = {
    cleanupId: 1,
    cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
    sessionGeneration: 1,
  };

  it("stops producers and purges every account-owned native and JS store", async () => {
    const calls: string[] = [];
    const operation = (name: string) =>
      vi.fn(async () => {
        calls.push(name);
      });
    const stop = (name: string) =>
      vi.fn(() => {
        calls.push(name);
      });
    const queryClient = {
      clear: vi.fn(() => {
        calls.push("query");
      }),
    };

    const result = await purgeMobileAccountState({
      cleanupLease,
      cutoff: "2026-07-26T12:00:00.000Z",
      dependencies: {
        advanceErasureCutoff: vi.fn(async (cutoff) => cutoff),
        clearBillingCheckoutOperation: operation("billing-checkout"),
        clearPreparation: operation("preparation"),
        clearSession: operation("session"),
        purgeCoreMotion: vi.fn(async (cutoff) => calls.push(`core-motion:${cutoff}`)),
        purgeFoodWriteBack: operation("food-writeback"),
        purgeExportCache: operation("export-cache"),
        purgeHealthKitState: vi.fn(async (cutoff) => calls.push(`health-kit-state:${cutoff}`)),
        purgeHeartRate: vi.fn(async (cutoff) => calls.push(`heart-rate:${cutoff}`)),
        purgeMedicationReminders: operation("medication-reminders"),
        purgeQueryCaches: operation("query-persistence"),
        purgeWatchMotion: vi.fn(async (cutoff) => calls.push(`watch-motion:${cutoff}`)),
        purgeWhoopBle: vi.fn(async (cutoff) => calls.push(`whoop:${cutoff}`)),
        teardownAccelerometer: stop("stop-accelerometer"),
        teardownHealthKit: stop("stop-health-kit"),
        teardownHeartRate: stop("stop-heart-rate"),
        teardownWatchMotion: stop("stop-watch"),
        teardownWhoopBle: stop("stop-whoop"),
      },
      isCleanupLeaseCurrent: () => true,
      queryClient,
    });

    expect(result.errors).toEqual([]);
    expect(calls.slice(0, 5)).toEqual([
      "stop-health-kit",
      "stop-accelerometer",
      "stop-watch",
      "stop-whoop",
      "stop-heart-rate",
    ]);
    expect(calls).toEqual(
      expect.arrayContaining([
        "food-writeback",
        "health-kit-state:2026-07-26T12:00:00.000Z",
        "core-motion:2026-07-26T12:00:00.000Z",
        "watch-motion:2026-07-26T12:00:00.000Z",
        "whoop:2026-07-26T12:00:00.000Z",
        "heart-rate:2026-07-26T12:00:00.000Z",
        "medication-reminders",
        "export-cache",
        "query-persistence",
        "billing-checkout",
        "session",
        "preparation",
        "query",
      ]),
    );
  });

  it("does not clear the account session until the serialized heart-rate purge resolves", async () => {
    let finishHeartRatePurge: (() => void) | undefined;
    const purgeHeartRate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishHeartRatePurge = resolve;
        }),
    );
    const clearSession = vi.fn();
    const later = vi.fn();

    const purge = purgeMobileAccountState({
      cleanupLease,
      dependencies: {
        advanceErasureCutoff: vi.fn(async (cutoff) => cutoff),
        clearBillingCheckoutOperation: later,
        clearPreparation: later,
        clearSession,
        purgeCoreMotion: later,
        purgeFoodWriteBack: later,
        purgeExportCache: later,
        purgeHealthKitState: later,
        purgeHeartRate,
        purgeMedicationReminders: later,
        purgeQueryCaches: later,
        purgeWatchMotion: later,
        purgeWhoopBle: later,
        teardownAccelerometer: vi.fn(),
        teardownHealthKit: vi.fn(),
        teardownWatchMotion: vi.fn(),
        teardownWhoopBle: vi.fn(),
      },
      isCleanupLeaseCurrent: () => true,
      queryClient: { clear: vi.fn() },
    });

    await vi.waitFor(() => expect(purgeHeartRate).toHaveBeenCalledOnce());
    expect(clearSession).not.toHaveBeenCalled();

    finishHeartRatePurge?.();
    await purge;

    expect(clearSession).toHaveBeenCalledOnce();
  });

  it("continues all cleanup attempts and reports each failure", async () => {
    const laterCleanup = vi.fn().mockResolvedValue(undefined);
    const result = await purgeMobileAccountState({
      cleanupLease,
      dependencies: {
        advanceErasureCutoff: vi.fn(async (cutoff) => cutoff),
        clearBillingCheckoutOperation: laterCleanup,
        clearPreparation: laterCleanup,
        clearSession: laterCleanup,
        purgeCoreMotion: vi.fn().mockRejectedValue(new Error("motion failed")),
        purgeFoodWriteBack: vi.fn().mockRejectedValue(new Error("health failed")),
        purgeExportCache: vi.fn().mockRejectedValue(new Error("export cache failed")),
        purgeHealthKitState: laterCleanup,
        purgeHeartRate: laterCleanup,
        purgeMedicationReminders: vi
          .fn()
          .mockRejectedValue(new Error("medication reminders failed")),
        purgeQueryCaches: laterCleanup,
        purgeWatchMotion: laterCleanup,
        purgeWhoopBle: laterCleanup,
        teardownAccelerometer: vi.fn(),
        teardownHealthKit: vi.fn(),
        teardownHeartRate: vi.fn(),
        teardownWatchMotion: vi.fn(),
        teardownWhoopBle: vi.fn(),
      },
      isCleanupLeaseCurrent: () => true,
      queryClient: { clear: vi.fn() },
    });

    expect(result.errors.map((error) => error.message)).toEqual([
      "health failed",
      "motion failed",
      "medication reminders failed",
      "export cache failed",
    ]);
    expect(laterCleanup).toHaveBeenCalled();
  });

  it("reports purge failures without sending account identifiers or capabilities", async () => {
    const secrets = {
      preparationToken: "private-preparation-token",
      statusToken: "private-status-token",
      userId: "private-user-id",
    };
    await purgeMobileAccountState({
      cleanupLease,
      dependencies: {
        advanceErasureCutoff: vi.fn(async (cutoff) => cutoff),
        clearBillingCheckoutOperation: vi.fn(),
        clearPreparation: vi.fn(),
        clearSession: vi.fn(),
        purgeCoreMotion: vi.fn(),
        purgeFoodWriteBack: vi.fn().mockRejectedValue(new Error(JSON.stringify(secrets))),
        purgeExportCache: vi.fn(),
        purgeHealthKitState: vi.fn(),
        purgeHeartRate: vi.fn(),
        purgeMedicationReminders: vi.fn(),
        purgeQueryCaches: vi.fn(),
        purgeWatchMotion: vi.fn(),
        purgeWhoopBle: vi.fn(),
        teardownAccelerometer: vi.fn(),
        teardownHealthKit: vi.fn(),
        teardownHeartRate: vi.fn(),
        teardownWatchMotion: vi.fn(),
        teardownWhoopBle: vi.fn(),
      },
      isCleanupLeaseCurrent: () => true,
      queryClient: { clear: vi.fn() },
    });

    const telemetry = mockCaptureException.mock.calls
      .map(
        ([error, context]) =>
          `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(context)}`,
      )
      .join(" ");
    expect(telemetry).not.toContain(secrets.userId);
    expect(telemetry).not.toContain(secrets.statusToken);
    expect(telemetry).not.toContain(secrets.preparationToken);
  });

  it("uses the retained newer cutoff for every native purge", async () => {
    const nativePurge = vi.fn();
    await purgeMobileAccountState({
      cleanupLease,
      cutoff: "2026-07-25T12:00:00.000Z",
      dependencies: {
        advanceErasureCutoff: vi.fn().mockResolvedValue("2026-07-26T12:00:00.000Z"),
        clearBillingCheckoutOperation: vi.fn(),
        clearPreparation: vi.fn(),
        clearSession: vi.fn(),
        purgeCoreMotion: nativePurge,
        purgeFoodWriteBack: vi.fn(),
        purgeExportCache: vi.fn(),
        purgeHealthKitState: nativePurge,
        purgeHeartRate: nativePurge,
        purgeMedicationReminders: vi.fn(),
        purgeQueryCaches: vi.fn(),
        purgeWatchMotion: nativePurge,
        purgeWhoopBle: nativePurge,
        teardownAccelerometer: vi.fn(),
        teardownHealthKit: vi.fn(),
        teardownHeartRate: vi.fn(),
        teardownWatchMotion: vi.fn(),
        teardownWhoopBle: vi.fn(),
      },
      isCleanupLeaseCurrent: () => true,
      queryClient: { clear: vi.fn() },
    });

    expect(nativePurge).toHaveBeenCalledTimes(5);
    expect(nativePurge).toHaveBeenCalledWith("2026-07-26T12:00:00.000Z");
  });

  it("marks cleanup failed while still giving native stores a cutoff to protect a later account", async () => {
    const nativePurge = vi.fn();
    const result = await purgeMobileAccountState({
      cleanupLease,
      cutoff: "2026-07-26T12:00:00.000Z",
      dependencies: {
        advanceErasureCutoff: vi.fn().mockRejectedValue(new Error("SecureStore unavailable")),
        clearBillingCheckoutOperation: vi.fn(),
        clearPreparation: vi.fn(),
        clearSession: vi.fn(),
        purgeCoreMotion: nativePurge,
        purgeFoodWriteBack: vi.fn(),
        purgeExportCache: vi.fn(),
        purgeHealthKitState: nativePurge,
        purgeHeartRate: nativePurge,
        purgeMedicationReminders: vi.fn(),
        purgeQueryCaches: vi.fn(),
        purgeWatchMotion: nativePurge,
        purgeWhoopBle: nativePurge,
        teardownAccelerometer: vi.fn(),
        teardownHealthKit: vi.fn(),
        teardownHeartRate: vi.fn(),
        teardownWatchMotion: vi.fn(),
        teardownWhoopBle: vi.fn(),
      },
      isCleanupLeaseCurrent: () => true,
      queryClient: { clear: vi.fn() },
    });

    expect(result.errors.map((error) => error.message)).toContain("SecureStore unavailable");
    expect(nativePurge).toHaveBeenCalledTimes(5);
    expect(nativePurge).toHaveBeenCalledWith("2026-07-26T12:00:00.000Z");
  });

  it("does not clear SecureStore, native state, or shared caches for a stale cleanup lease", async () => {
    const operation = vi.fn();
    const queryClient = { clear: vi.fn() };
    const result = await purgeMobileAccountState({
      cleanupLease,
      dependencies: {
        advanceErasureCutoff: operation,
        clearBillingCheckoutOperation: operation,
        clearPreparation: operation,
        clearSession: operation,
        purgeCoreMotion: operation,
        purgeFoodWriteBack: operation,
        purgeExportCache: operation,
        purgeHealthKitState: operation,
        purgeHeartRate: operation,
        purgeMedicationReminders: operation,
        purgeQueryCaches: operation,
        purgeWatchMotion: operation,
        purgeWhoopBle: operation,
        teardownAccelerometer: operation,
        teardownHealthKit: operation,
        teardownHeartRate: operation,
        teardownWatchMotion: operation,
        teardownWhoopBle: operation,
      },
      isCleanupLeaseCurrent: () => false,
      queryClient,
    });

    expect(result.errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/another account became active/i),
    ]);
    expect(operation).not.toHaveBeenCalled();
    expect(queryClient.clear).not.toHaveBeenCalled();
  });

  it("stops before later destructive targets when the session generation changes", async () => {
    let leaseCurrent = true;
    const clearSession = vi.fn();
    const purgeCoreMotion = vi.fn(async () => {
      leaseCurrent = false;
    });
    const purgeMedicationReminders = vi.fn();
    const purgeQueryCaches = vi.fn();
    const queryClient = { clear: vi.fn() };

    const result = await purgeMobileAccountState({
      cleanupLease,
      dependencies: {
        advanceErasureCutoff: vi.fn(async (cutoff) => cutoff),
        clearBillingCheckoutOperation: vi.fn(),
        clearPreparation: vi.fn(),
        clearSession,
        purgeCoreMotion,
        purgeFoodWriteBack: vi.fn(),
        purgeExportCache: vi.fn(),
        purgeHealthKitState: vi.fn(),
        purgeHeartRate: vi.fn(),
        purgeMedicationReminders,
        purgeQueryCaches,
        purgeWatchMotion: vi.fn(),
        purgeWhoopBle: vi.fn(),
        teardownAccelerometer: vi.fn(),
        teardownHealthKit: vi.fn(),
        teardownHeartRate: vi.fn(),
        teardownWatchMotion: vi.fn(),
        teardownWhoopBle: vi.fn(),
      },
      isCleanupLeaseCurrent: () => leaseCurrent,
      queryClient,
    });

    expect(purgeCoreMotion).toHaveBeenCalledOnce();
    expect(result.errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/another account became active/i),
    ]);
    expect(purgeQueryCaches).not.toHaveBeenCalled();
    expect(purgeMedicationReminders).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(queryClient.clear).not.toHaveBeenCalled();
  });
});
