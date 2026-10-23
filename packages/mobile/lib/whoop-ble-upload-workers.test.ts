import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopBleDiagnostics } from "./whoop-ble-diagnostics";
import type {
  InertialMeasurementUnitUploadClient,
  WhoopBleRealtimeUploadClient,
  WhoopBleSyncDeps,
} from "./whoop-ble-sync-types";
import {
  makeMockDeps,
  makeMockRealtimeClient,
  makeMockTrpcClient,
  makeWhoopCaptureStats,
} from "./whoop-ble-test-helpers";

vi.mock("./telemetry", () => ({
  captureException: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { mockLoadDeviceErasureCutoff } = vi.hoisted(() => ({
  mockLoadDeviceErasureCutoff: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("./device-erasure-cutoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./device-erasure-cutoff")>()),
  loadDeviceErasureCutoff: mockLoadDeviceErasureCutoff,
}));

import { WhoopBleUploadWorkers } from "./whoop-ble-upload-workers";

let whoopDeps: WhoopBleSyncDeps;
let trpcClient: InertialMeasurementUnitUploadClient;
let realtimeClient: WhoopBleRealtimeUploadClient;
let diagnostics: WhoopBleDiagnostics;
beforeEach(() => {
  whoopDeps = makeMockDeps();
  trpcClient = makeMockTrpcClient();
  realtimeClient = makeMockRealtimeClient();
  diagnostics = new WhoopBleDiagnostics();
  diagnostics.snapshot(makeWhoopCaptureStats(), "initial", "active");
  mockLoadDeviceErasureCutoff.mockResolvedValue(null);
  AppState.currentState = "active";
});

let workers: WhoopBleUploadWorkers | undefined;
afterEach(() => {
  workers?.retire();
  workers = undefined;
});
function runWorkers(includeRealtime = true) {
  workers ??= new WhoopBleUploadWorkers(trpcClient, whoopDeps, diagnostics);
  return workers.drain(
    includeRealtime ? realtimeClient : undefined,
    () => AppState.currentState === "active",
    "initial",
  );
}
async function runBackgroundWorkers() {
  workers ??= new WhoopBleUploadWorkers(trpcClient, whoopDeps, diagnostics);
  const finish = workers.authorizeBackgroundRefresh();
  try {
    await workers.drain(realtimeClient, () => true, "background");
  } finally {
    finish();
  }
}
describe("WHOOP stream worker ownership", () => {
  it("does not issue a queued native peek after the lifetime retires", async () => {
    const draining = runWorkers();
    await Promise.resolve();
    workers?.retire();
    await draining;
    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();
    expect(whoopDeps.peekBufferedRealtimeData).not.toHaveBeenCalled();
  });

  it("abandons an old cutoff read without blocking or mutating the next lifetime", async () => {
    let finishOldCutoff: (() => void) | undefined;
    mockLoadDeviceErasureCutoff.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldCutoff = () => resolve(null);
        }),
    );
    const oldDrain = runWorkers();
    workers?.retire();
    workers = new WhoopBleUploadWorkers(makeMockTrpcClient(), whoopDeps, new WhoopBleDiagnostics());
    await workers.drain(undefined, () => true, "initial");
    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(1);
    finishOldCutoff?.();
    await oldDrain;
    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(1);
  });

  it.each(["imu", "realtime"] as const)(
    "keeps the new %s worker shared when a retired HTTP response settles",
    async (stream) => {
      const imu = { timestamp: "2026-03-30T12:00:00.000Z", x: 1, y: 2, z: 3 };
      const realtime = {
        timestamp: imu.timestamp,
        heartRateBpm: 75,
        rrIntervalMs: 800,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      };
      const peek =
        stream === "imu" ? whoopDeps.peekBufferedSamples : whoopDeps.peekBufferedRealtimeData;
      vi.mocked(peek)
        .mockResolvedValueOnce([stream === "imu" ? imu : realtime])
        .mockResolvedValueOnce([stream === "imu" ? imu : realtime]);
      const oldUpload =
        stream === "imu"
          ? trpcClient.inertialMeasurementUnitSync.pushSamples.mutate
          : realtimeClient.whoopBleSync.pushRealtimeData.mutate;
      const nextClient = makeMockTrpcClient();
      const nextRealtime = makeMockRealtimeClient();
      const nextUpload =
        stream === "imu"
          ? nextClient.inertialMeasurementUnitSync.pushSamples.mutate
          : nextRealtime.whoopBleSync.pushRealtimeData.mutate;
      let resolveOld: (() => void) | undefined;
      let resolveNext: (() => void) | undefined;
      vi.mocked(oldUpload).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOld = () => resolve({ inserted: 1 });
          }),
      );
      vi.mocked(nextUpload).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveNext = () => resolve({ inserted: 1 });
          }),
      );
      const oldDrain = runWorkers();
      await vi.waitFor(() => expect(oldUpload).toHaveBeenCalledTimes(1));
      workers?.retire();
      workers = new WhoopBleUploadWorkers(nextClient, whoopDeps, new WhoopBleDiagnostics());
      const nextDrain = workers.drain(nextRealtime, () => true, "initial");
      let joined: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(nextUpload).toHaveBeenCalledTimes(1));
        resolveOld?.();
        await oldDrain;
        joined = workers.drain(nextRealtime, () => true, "periodic");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(nextUpload).toHaveBeenCalledTimes(1);
        expect(peek).toHaveBeenCalledTimes(2);
      } finally {
        resolveOld?.();
        resolveNext?.();
        await Promise.all([oldDrain, nextDrain, joined]);
      }
      const confirm =
        stream === "imu" ? whoopDeps.confirmSamplesDrain : whoopDeps.confirmRealtimeDataDrain;
      expect(vi.mocked(confirm).mock.calls.filter(([count]) => count > 0)).toEqual([[1]]);
    },
  );

  it("does not inherit background permission from a retired refresh", async () => {
    const sample = { timestamp: "2026-03-30T12:00:00.000Z", x: 1, y: 2, z: 3 };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([sample]);
    let releaseOld: (() => void) | undefined;
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOld = () => resolve({ inserted: 1 });
        }),
    );
    const oldRefresh = runBackgroundWorkers();
    await vi.waitFor(() => expect(releaseOld).toBeDefined());
    workers?.retire();
    const nextClient = makeMockTrpcClient();
    workers = new WhoopBleUploadWorkers(nextClient, whoopDeps, new WhoopBleDiagnostics());
    AppState.currentState = "background";
    try {
      await workers.drain(realtimeClient, () => AppState.currentState === "active", "initial");
      expect(nextClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
      expect(
        vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
      ).toEqual([]);
    } finally {
      releaseOld?.();
      await oldRefresh;
    }
  });

  it("reports a failed cursor release without releasing a later owner", async () => {
    const { captureException } = await import("./telemetry");
    const releaseError = new Error("native cursor release failed");
    vi.mocked(whoopDeps.confirmSamplesDrain).mockImplementationOnce(() => {
      throw releaseError;
    });
    await runWorkers(false);
    expect(captureException).toHaveBeenCalledWith(releaseError, {
      source: "whoop-ble-release-native-peek",
      stream: "imu",
      retiredLifetime: false,
    });
    const releases = vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.length;
    workers?.retire();
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledTimes(releases);
  });

  it.each(["motion", "realtime"] as const)(
    "drains %s while the other upload stream is stalled",
    async (progressingStream) => {
      type BufferedRealtimeSample = Awaited<
        ReturnType<WhoopBleSyncDeps["peekBufferedRealtimeData"]>
      >[number];
      const imuBuffer = Array.from({ length: 2 }, (_, index) => ({
        deviceId: "whoop-a",
        timestamp: new Date(Date.UTC(2026, 2, 30, 12, 0, 0, index)).toISOString(),
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      }));
      const realtimeBuffer: BufferedRealtimeSample[] = Array.from({ length: 2 }, (_, index) => ({
        deviceId: "whoop-a",
        timestamp: new Date(Date.UTC(2026, 2, 30, 12, 0, 0, index)).toISOString(),
        heartRateBpm: 75,
        rrIntervalMs: 800,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      }));
      let releaseMotion: (() => void) | undefined;
      let releaseRealtime: (() => void) | undefined;
      const motionGate = new Promise<void>((resolve) => {
        releaseMotion = resolve;
      });
      const realtimeGate = new Promise<void>((resolve) => {
        releaseRealtime = resolve;
      });
      const acceptedMotion: string[] = [];
      const acceptedRealtime: string[] = [];
      mockLoadDeviceErasureCutoff.mockResolvedValue(null);
      vi.mocked(whoopDeps.peekBufferedSamples).mockImplementation(async (maxCount) =>
        imuBuffer.slice(0, Math.min(maxCount ?? 1, 1)),
      );
      vi.mocked(whoopDeps.confirmSamplesDrain).mockImplementation((count) => {
        imuBuffer.splice(0, count);
      });
      vi.mocked(whoopDeps.peekBufferedRealtimeData).mockImplementation(async (maxCount) =>
        realtimeBuffer.slice(0, Math.min(maxCount ?? 1, 1)),
      );
      vi.mocked(whoopDeps.confirmRealtimeDataDrain).mockImplementation((count) => {
        realtimeBuffer.splice(0, count);
      });
      vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
        async ({ samples }) => {
          await motionGate;
          acceptedMotion.push(...samples.map((sample) => sample.timestamp));
          return { inserted: samples.length };
        },
      );
      vi.mocked(realtimeClient.whoopBleSync.pushRealtimeData.mutate).mockImplementation(
        async ({ samples }) => {
          await realtimeGate;
          acceptedRealtime.push(...samples.map((sample) => sample.timestamp));
          return { inserted: samples.length };
        },
      );

      const initialization = runWorkers();
      try {
        await vi.waitFor(() => {
          expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(
            1,
          );
          expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledTimes(1);
        });
        expect(imuBuffer).toHaveLength(2);
        expect(realtimeBuffer).toHaveLength(2);

        if (progressingStream === "motion") releaseMotion?.();
        else releaseRealtime?.();
        const accepted = progressingStream === "motion" ? acceptedMotion : acceptedRealtime;
        const stalledBuffer = progressingStream === "motion" ? realtimeBuffer : imuBuffer;
        const stalledUpload =
          progressingStream === "motion"
            ? realtimeClient.whoopBleSync.pushRealtimeData.mutate
            : trpcClient.inertialMeasurementUnitSync.pushSamples.mutate;
        await vi.waitFor(() =>
          expect(accepted).toEqual(["2026-03-30T12:00:00.000Z", "2026-03-30T12:00:00.001Z"]),
        );
        expect(stalledBuffer).toHaveLength(2);
        expect(stalledUpload).toHaveBeenCalledTimes(1);
      } finally {
        releaseMotion?.();
        releaseRealtime?.();
        await initialization;
      }
      expect(imuBuffer).toHaveLength(0);
      expect(realtimeBuffer).toHaveLength(0);
      expect(
        vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
      ).toHaveLength(2);
      expect(
        vi.mocked(whoopDeps.confirmRealtimeDataDrain).mock.calls.filter(([count]) => count > 0),
      ).toHaveLength(2);
    },
  );

  it("waits for the surviving upload after the other buffer rejects", async () => {
    const { captureException } = await import("./telemetry");
    vi.mocked(captureException).mockClear();
    const realtimeError = new Error("realtime buffer unavailable");
    let releaseMotion: (() => void) | undefined;
    const motionGate = new Promise<void>((resolve) => {
      releaseMotion = resolve;
    });
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce([
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 0,
        gyroscopeY: 0,
        gyroscopeZ: 0,
      },
    ]);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockRejectedValue(realtimeError);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
      async () => {
        await motionGate;
        return { inserted: 1 };
      },
    );
    let settled = false;
    let rejection: unknown;
    const initialization = runWorkers().then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        rejection = error;
      },
    );
    try {
      await vi.waitFor(() => expect(whoopDeps.peekBufferedRealtimeData).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalledWith(realtimeError, expect.anything());
    } finally {
      releaseMotion?.();
      await initialization;
    }
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(1);
    expect(rejection).toBe(realtimeError);
  });

  it("preserves both unexpected buffer errors", async () => {
    const motionError = new Error("motion buffer unavailable");
    const realtimeError = new Error("realtime buffer unavailable");
    vi.mocked(whoopDeps.peekBufferedSamples).mockRejectedValue(motionError);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockRejectedValue(realtimeError);

    await expect(runBackgroundWorkers()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [motionError, realtimeError],
    });
  });

  it("shares in-flight uploads with an overlapping background refresh", async () => {
    let releaseUploads: (() => void) | undefined;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const motionSample = {
      timestamp: "2026-03-30T12:00:00.000Z",
      x: 1,
      y: 2,
      z: 3,
      gyroscopeX: 0,
      gyroscopeY: 0,
      gyroscopeZ: 0,
    };
    const realtimeSample = {
      timestamp: "2026-03-30T12:00:00.000Z",
      heartRateBpm: 75,
      rrIntervalMs: 800,
      quaternionW: 1,
      quaternionX: 0,
      quaternionY: 0,
      quaternionZ: 0,
      opticalRawHex: "000000000000000000000000000000000000",
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([motionSample]);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValue([realtimeSample]);
    vi.mocked(whoopDeps.confirmSamplesDrain).mockImplementation(() => {
      vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([]);
    });
    vi.mocked(whoopDeps.confirmRealtimeDataDrain).mockImplementation(() => {
      vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValue([]);
    });
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
      async () => {
        await uploadGate;
        return { inserted: 1 };
      },
    );
    vi.mocked(realtimeClient.whoopBleSync.pushRealtimeData.mutate).mockImplementation(async () => {
      await uploadGate;
      return { inserted: 1 };
    });

    const initialization = runWorkers();
    let backgroundRefresh: Promise<void> | undefined;
    try {
      await vi.waitFor(() =>
        expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1),
      );
      backgroundRefresh = runBackgroundWorkers();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
      expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledTimes(1);
    } finally {
      releaseUploads?.();
      await Promise.all([initialization, backgroundRefresh]);
    }
    expect(
      vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
    ).toHaveLength(1);
    expect(
      vi.mocked(whoopDeps.confirmRealtimeDataDrain).mock.calls.filter(([count]) => count > 0),
    ).toHaveLength(1);
  });

  it("continues a shared motion drain during an authorized background refresh", async () => {
    let releaseMotion: (() => void) | undefined;
    const motionGate = new Promise<void>((resolve) => {
      releaseMotion = resolve;
    });
    const motionBuffer = Array.from({ length: 2 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 2, 30, 12, 0, index)).toISOString(),
      x: 1,
      y: 2,
      z: 3,
      gyroscopeX: 0,
      gyroscopeY: 0,
      gyroscopeZ: 0,
    }));
    vi.mocked(whoopDeps.peekBufferedSamples).mockImplementation(async () =>
      motionBuffer.slice(0, 1),
    );
    vi.mocked(whoopDeps.confirmSamplesDrain).mockImplementation((count) => {
      motionBuffer.splice(0, count);
    });
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
      async () => {
        await motionGate;
        return { inserted: 1 };
      },
    );
    const initialization = runWorkers();
    let backgroundRefresh: Promise<void> | undefined;
    try {
      await vi.waitFor(() =>
        expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1),
      );
      AppState.currentState = "background";
      backgroundRefresh = runBackgroundWorkers();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
      releaseMotion?.();
      await backgroundRefresh;
      expect(motionBuffer).toHaveLength(0);
      expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
      ).toHaveLength(2);
    } finally {
      releaseMotion?.();
      await Promise.all([initialization, backgroundRefresh]);
    }
  });
});
