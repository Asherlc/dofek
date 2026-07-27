import type { InertialMeasurementUnitSample } from "@dofek/imu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InertialMeasurementUnitAdapter,
  type InertialMeasurementUnitSyncTrpcClient,
  syncInertialMeasurementUnitToServer,
} from "./inertial-measurement-unit-sync";

function makeAdapter(
  overrides: Partial<InertialMeasurementUnitAdapter> = {},
): InertialMeasurementUnitAdapter {
  return {
    isAccelerometerRecordingAvailable: () => true,
    queryRecordedData: vi.fn().mockResolvedValue([]),
    getLastSyncTimestamp: () => null,
    setLastSyncTimestamp: vi.fn(),
    startRecording: vi.fn().mockResolvedValue(true),
    isRecordingActive: () => false,
    ...overrides,
  };
}

function makeTrpcClient(
  overrides: Partial<{
    pushResult: { inserted: number };
  }> = {},
): InertialMeasurementUnitSyncTrpcClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue(overrides.pushResult ?? { inserted: 0 }),
      },
    },
  };
}

function makeSamples(count: number): InertialMeasurementUnitSample[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(Date.now() - (count - index) * 20).toISOString(),
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    z: Math.random() * 2 - 1,
  }));
}

describe("syncInertialMeasurementUnitToServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns zero when accelerometer is not available", async () => {
    const coreMotion = makeAdapter({
      isAccelerometerRecordingAvailable: () => false,
    });
    const trpcClient = makeTrpcClient();

    const result = await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(result.inserted).toBe(0);
    expect(result.recording).toBe(false);
  });

  it("queries from lastSyncTimestamp when available", async () => {
    const queryRecordedData = vi.fn().mockResolvedValue([]);
    const lastSync = new Date(Date.now() - 60_000).toISOString();
    const coreMotion = makeAdapter({
      getLastSyncTimestamp: () => lastSync,
      queryRecordedData,
    });
    const trpcClient = makeTrpcClient();

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(queryRecordedData).toHaveBeenCalledTimes(1);
    const [fromDate] = queryRecordedData.mock.calls[0];
    expect(fromDate).toBe(lastSync);
  });

  it("keeps CoreMotion queries inside the retained sensor history window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T19:00:00.000Z"));

    const queryRecordedData = vi.fn().mockResolvedValue([]);
    const staleLastSync = new Date("2026-05-10T19:00:00.000Z").toISOString();
    const coreMotion = makeAdapter({
      getLastSyncTimestamp: () => staleLastSync,
      queryRecordedData,
    });
    const trpcClient = makeTrpcClient();

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(queryRecordedData).toHaveBeenCalledTimes(1);
    const [fromDate] = queryRecordedData.mock.calls[0];
    expect(fromDate).toBe("2026-05-17T21:24:00.000Z");
  });

  it("never uploads Core Motion history from before a deleted account cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T13:00:00.000Z"));
    const cutoff = "2026-05-20T12:00:00.000Z";
    const queryRecordedData = vi.fn().mockResolvedValue([
      { timestamp: "2026-05-20T11:59:59.999Z", x: 1, y: 1, z: 1 },
      { timestamp: cutoff, x: 2, y: 2, z: 2 },
      { timestamp: "2026-05-20T12:00:00.001Z", x: 3, y: 3, z: 3 },
    ]);
    const coreMotion = makeAdapter({
      getLastSyncTimestamp: () => "2026-05-20T11:00:00.000Z",
      queryRecordedData,
    });
    const trpcClient = makeTrpcClient({ pushResult: { inserted: 1 } });

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
      minimumSampleDate: cutoff,
    });

    expect(queryRecordedData).toHaveBeenCalledWith(cutoff, "2026-05-20T12:10:00.000Z");
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
      samples: [{ timestamp: "2026-05-20T12:00:00.001Z", x: 3, y: 3, z: 3 }],
    });
  });

  it("limits each CoreMotion query to ten minutes while catching up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T19:00:00.000Z"));

    const queryRecordedData = vi.fn().mockResolvedValue([]);
    const setLastSyncTimestamp = vi.fn();
    const lastSync = new Date("2026-05-20T18:00:00.000Z").toISOString();
    const coreMotion = makeAdapter({
      getLastSyncTimestamp: () => lastSync,
      queryRecordedData,
      setLastSyncTimestamp,
    });
    const trpcClient = makeTrpcClient();

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(queryRecordedData).toHaveBeenCalledTimes(1);
    const [fromDate, toDate] = queryRecordedData.mock.calls[0];
    expect(fromDate).toBe("2026-05-20T18:00:00.000Z");
    expect(toDate).toBe("2026-05-20T18:10:00.000Z");
    expect(setLastSyncTimestamp).toHaveBeenCalledWith("2026-05-20T18:10:00.000Z");
  });

  it("uploads samples in batches of 5000", async () => {
    const samples = makeSamples(7500);
    const coreMotion = makeAdapter({
      queryRecordedData: vi.fn().mockResolvedValue(samples),
    });
    const trpcClient = makeTrpcClient({ pushResult: { inserted: 5000 } });

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    const mutate = trpcClient.inertialMeasurementUnitSync.pushSamples.mutate;
    expect(mutate).toHaveBeenCalledTimes(2);

    // First batch: 5000 samples
    const firstCall = vi.mocked(mutate).mock.calls[0][0];
    expect(firstCall.samples).toHaveLength(5000);
    expect(firstCall.deviceId).toBe("iPhone 15 Pro");
    expect(firstCall.deviceType).toBe("iphone");

    // Second batch: 2500 samples
    const secondCall = vi.mocked(mutate).mock.calls[1][0];
    expect(secondCall.samples).toHaveLength(2500);
  });

  it("advances sync cursor only after all batches succeed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T19:00:00.000Z"));

    const samples = makeSamples(100);
    const setLastSyncTimestamp = vi.fn();
    const lastSync = new Date("2026-05-20T18:59:00.000Z").toISOString();
    const coreMotion = makeAdapter({
      getLastSyncTimestamp: () => lastSync,
      queryRecordedData: vi.fn().mockResolvedValue(samples),
      setLastSyncTimestamp,
    });
    const trpcClient = makeTrpcClient({ pushResult: { inserted: 100 } });

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(setLastSyncTimestamp).toHaveBeenCalledTimes(1);
    expect(setLastSyncTimestamp).toHaveBeenCalledWith("2026-05-20T19:00:00.000Z");
  });

  it("does not advance cursor when upload fails", async () => {
    const samples = makeSamples(100);
    const setLastSyncTimestamp = vi.fn();
    const coreMotion = makeAdapter({
      queryRecordedData: vi.fn().mockResolvedValue(samples),
      setLastSyncTimestamp,
    });
    const trpcClient = makeTrpcClient();
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockRejectedValue(
      new Error("Network error"),
    );

    await expect(
      syncInertialMeasurementUnitToServer({
        trpcClient,
        coreMotion,
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
      }),
    ).rejects.toThrow("Network error");

    expect(setLastSyncTimestamp).not.toHaveBeenCalled();
  });

  it("restarts recording after sync", async () => {
    const startRecording = vi.fn().mockResolvedValue(true);
    const coreMotion = makeAdapter({ startRecording });
    const trpcClient = makeTrpcClient();

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(startRecording).toHaveBeenCalledWith(43200); // 12 hours
  });

  it("handles empty data gracefully", async () => {
    const setLastSyncTimestamp = vi.fn();
    const coreMotion = makeAdapter({
      queryRecordedData: vi.fn().mockResolvedValue([]),
      setLastSyncTimestamp,
    });
    const trpcClient = makeTrpcClient();

    const result = await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "iPhone 15 Pro",
      deviceType: "iphone",
    });

    expect(result.inserted).toBe(0);
    // Should still advance cursor (no data to sync = up to date)
    expect(setLastSyncTimestamp).toHaveBeenCalledTimes(1);
    // Should not call push mutation
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
  });

  it("passes gyroscope data through to server", async () => {
    const samplesWithGyro: InertialMeasurementUnitSample[] = [
      {
        timestamp: new Date().toISOString(),
        x: 0.01,
        y: -0.98,
        z: 0.04,
        gyroscopeX: 0.15,
        gyroscopeY: -0.22,
        gyroscopeZ: 0.08,
      },
    ];
    const coreMotion = makeAdapter({
      queryRecordedData: vi.fn().mockResolvedValue(samplesWithGyro),
    });
    const trpcClient = makeTrpcClient({ pushResult: { inserted: 1 } });

    await syncInertialMeasurementUnitToServer({
      trpcClient,
      coreMotion,
      deviceId: "Apple Watch",
      deviceType: "apple_watch",
    });

    const mutate = trpcClient.inertialMeasurementUnitSync.pushSamples.mutate;
    expect(mutate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mutate).mock.calls[0][0];
    expect(call.samples[0].gyroscopeX).toBe(0.15);
    expect(call.samples[0].gyroscopeY).toBe(-0.22);
    expect(call.samples[0].gyroscopeZ).toBe(0.08);
  });
});
