import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInertialMeasurementUnitService,
  type InertialMeasurementUnitService,
  type InertialMeasurementUnitServiceDeps,
} from "./inertial-measurement-unit-service.ts";

function makeMockWhoopBle() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    findAndConnect: vi.fn().mockResolvedValue(true),
    startStreaming: vi.fn().mockResolvedValue(true),
    stopStreaming: vi.fn().mockResolvedValue(true),
    getBufferedSamples: vi.fn().mockResolvedValue([]),
  };
}

function makeMockDeps(): InertialMeasurementUnitServiceDeps {
  return {
    coreMotion: {
      isAccelerometerRecordingAvailable: vi.fn().mockReturnValue(true),
      startRecording: vi.fn().mockResolvedValue(true),
      queryRecordedData: vi.fn().mockResolvedValue([]),
    },
    watch: {
      isAvailable: vi.fn().mockReturnValue(true),
      requestSync: vi.fn().mockResolvedValue(true),
      getPendingSamples: vi.fn().mockResolvedValue([]),
      acknowledgeSamples: vi.fn(),
    },
    whoopBle: makeMockWhoopBle(),
    trpcClient: {
      inertialMeasurementUnitSync: {
        pushSamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
        },
      },
    },
    deviceId: "iPhone 15 Pro",
  };
}

describe("InertialMeasurementUnitService", () => {
  let deps: InertialMeasurementUnitServiceDeps;
  let service: InertialMeasurementUnitService;

  beforeEach(() => {
    deps = makeMockDeps();
    service = createInertialMeasurementUnitService(deps);
  });

  describe("ensureRecording", () => {
    it("starts a 12-hour CoreMotion recording session", async () => {
      await service.ensureRecording();

      expect(deps.coreMotion.startRecording).toHaveBeenCalledWith(43200);
    });

    it("requests Watch sync when watch is available", async () => {
      await service.ensureRecording();

      expect(deps.watch.requestSync).toHaveBeenCalled();
    });

    it("skips CoreMotion when accelerometer is unavailable", async () => {
      vi.mocked(deps.coreMotion.isAccelerometerRecordingAvailable).mockReturnValue(false);

      await service.ensureRecording();

      expect(deps.coreMotion.startRecording).not.toHaveBeenCalled();
    });

    it("skips Watch sync when watch is unavailable", async () => {
      vi.mocked(deps.watch.isAvailable).mockReturnValue(false);

      await service.ensureRecording();

      expect(deps.watch.requestSync).not.toHaveBeenCalled();
    });

    it("does not throw when CoreMotion fails", async () => {
      vi.mocked(deps.coreMotion.startRecording).mockRejectedValue(new Error("CoreMotion error"));

      await expect(service.ensureRecording()).resolves.toBeUndefined();
    });

    it("does not throw when Watch sync fails", async () => {
      vi.mocked(deps.watch.requestSync).mockRejectedValue(new Error("Watch unreachable"));

      await expect(service.ensureRecording()).resolves.toBeUndefined();
    });
  });

  describe("syncForTimeRange", () => {
    const startedAt = "2026-03-25T08:00:00.000Z";
    const endedAt = "2026-03-25T09:00:00.000Z";

    it("queries CoreMotion for the time range and uploads samples", async () => {
      const samples = [
        { timestamp: "2026-03-25T08:00:00.100Z", x: 0.01, y: -0.98, z: 0.04 },
        { timestamp: "2026-03-25T08:00:00.120Z", x: 0.02, y: -0.97, z: 0.05 },
      ];
      vi.mocked(deps.coreMotion.queryRecordedData).mockResolvedValue(samples);

      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.coreMotion.queryRecordedData).toHaveBeenCalledWith(startedAt, endedAt);
      expect(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "iPhone 15 Pro",
        deviceType: "iphone",
        samples,
      });
    });

    it("uploads Watch pending samples", async () => {
      const watchSamples = [{ timestamp: "2026-03-25T08:00:00.100Z", x: 0.1, y: -0.9, z: 0.0 }];
      vi.mocked(deps.watch.getPendingSamples).mockResolvedValue(watchSamples);

      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Apple Watch",
        deviceType: "apple_watch",
        samples: watchSamples,
      });
      expect(deps.watch.acknowledgeSamples).toHaveBeenCalled();
    });

    it("does not upload when CoreMotion returns no samples", async () => {
      vi.mocked(deps.coreMotion.queryRecordedData).mockResolvedValue([]);
      vi.mocked(deps.watch.getPendingSamples).mockResolvedValue([]);

      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
    });

    it("skips CoreMotion query when unavailable", async () => {
      vi.mocked(deps.coreMotion.isAccelerometerRecordingAvailable).mockReturnValue(false);

      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.coreMotion.queryRecordedData).not.toHaveBeenCalled();
    });

    it("skips Watch query when unavailable", async () => {
      vi.mocked(deps.watch.isAvailable).mockReturnValue(false);

      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.watch.getPendingSamples).not.toHaveBeenCalled();
    });

    it("does not throw when CoreMotion query fails", async () => {
      vi.mocked(deps.coreMotion.queryRecordedData).mockRejectedValue(new Error("Query failed"));

      await expect(service.syncForTimeRange(startedAt, endedAt)).resolves.toBeUndefined();
    });

    it("does not throw when upload fails", async () => {
      const samples = [{ timestamp: "2026-03-25T08:00:00.100Z", x: 0.01, y: -0.98, z: 0.04 }];
      vi.mocked(deps.coreMotion.queryRecordedData).mockResolvedValue(samples);
      vi.mocked(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockRejectedValue(
        new Error("Upload failed"),
      );

      await expect(service.syncForTimeRange(startedAt, endedAt)).resolves.toBeUndefined();
    });

    it("does not acknowledge Watch samples when upload fails", async () => {
      const watchSamples = [{ timestamp: "2026-03-25T08:00:00.100Z", x: 0.1, y: -0.9, z: 0.0 }];
      vi.mocked(deps.watch.getPendingSamples).mockResolvedValue(watchSamples);
      vi.mocked(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockRejectedValue(
        new Error("Upload failed"),
      );

      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.watch.acknowledgeSamples).not.toHaveBeenCalled();
    });

    it("batches large sample sets", async () => {
      const largeSampleSet = Array.from({ length: 12000 }, (_, index) => ({
        timestamp: `2026-03-25T08:00:${String(Math.floor(index / 50)).padStart(2, "0")}.${String((index % 50) * 20).padStart(3, "0")}Z`,
        x: 0.01,
        y: -0.98,
        z: 0.04,
      }));
      vi.mocked(deps.coreMotion.queryRecordedData).mockResolvedValue(largeSampleSet);

      await service.syncForTimeRange(startedAt, endedAt);

      // 12000 samples / 5000 batch = 3 calls for phone data
      const calls = vi.mocked(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mock
        .calls;
      const phoneCalls = calls.filter(
        (call: Array<{ deviceType: string }>) => call[0].deviceType === "iphone",
      );
      expect(phoneCalls).toHaveLength(3);
      expect(phoneCalls[0][0].samples).toHaveLength(5000);
      expect(phoneCalls[1][0].samples).toHaveLength(5000);
      expect(phoneCalls[2][0].samples).toHaveLength(2000);
    });
  });

  describe("WHOOP BLE integration", () => {
    const startedAt = "2026-03-25T08:00:00.000Z";
    const endedAt = "2026-03-25T09:00:00.000Z";

    it("connects to WHOOP and starts streaming on ensureRecording", async () => {
      await service.ensureRecording();

      expect(deps.whoopBle?.findAndConnect).toHaveBeenCalled();
      expect(deps.whoopBle?.startStreaming).toHaveBeenCalled();
    });

    it("skips WHOOP when unavailable", async () => {
      const whoopBle = deps.whoopBle;
      if (!whoopBle) throw new Error("whoopBle not initialized");
      vi.mocked(whoopBle.isAvailable).mockReturnValue(false);

      await service.ensureRecording();

      expect(deps.whoopBle?.findAndConnect).not.toHaveBeenCalled();
    });

    it("does not throw when WHOOP connection fails", async () => {
      const whoopBle = deps.whoopBle;
      if (!whoopBle) throw new Error("whoopBle not initialized");
      vi.mocked(whoopBle.findAndConnect).mockRejectedValue(new Error("BLE error"));

      await expect(service.ensureRecording()).resolves.toBeUndefined();
    });

    it("does not start streaming when connection fails", async () => {
      const whoopBle = deps.whoopBle;
      if (!whoopBle) throw new Error("whoopBle not initialized");
      vi.mocked(whoopBle.findAndConnect).mockResolvedValue(false);

      await service.ensureRecording();

      expect(deps.whoopBle?.startStreaming).not.toHaveBeenCalled();
    });

    it("uploads WHOOP buffered samples on syncForTimeRange", async () => {
      const whoopSamples = [
        { timestamp: "2026-03-25T08:00:01.000Z", x: 100, y: -200, z: 300 },
        { timestamp: "2026-03-25T08:00:01.020Z", x: 101, y: -201, z: 301 },
      ];
      const whoopBle = deps.whoopBle;
      if (!whoopBle) throw new Error("whoopBle not initialized");
      vi.mocked(whoopBle.getBufferedSamples).mockResolvedValue(whoopSamples);

      await service.syncForTimeRange(startedAt, endedAt);

      const calls = vi.mocked(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mock
        .calls;
      const whoopCalls = calls.filter(
        (call: Array<{ deviceType: string }>) => call[0].deviceType === "whoop",
      );
      expect(whoopCalls).toHaveLength(1);
      expect(whoopCalls[0][0].deviceId).toBe("WHOOP Strap");
      expect(whoopCalls[0][0].samples).toHaveLength(2);
    });

    it("stops WHOOP streaming after sync", async () => {
      await service.syncForTimeRange(startedAt, endedAt);

      expect(deps.whoopBle?.stopStreaming).toHaveBeenCalled();
    });

    it("does not upload when WHOOP buffer is empty", async () => {
      const whoopBle = deps.whoopBle;
      if (!whoopBle) throw new Error("whoopBle not initialized");
      vi.mocked(whoopBle.getBufferedSamples).mockResolvedValue([]);

      await service.syncForTimeRange(startedAt, endedAt);

      const calls = vi.mocked(deps.trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mock
        .calls;
      const whoopCalls = calls.filter(
        (call: Array<{ deviceType: string }>) => call[0].deviceType === "whoop",
      );
      expect(whoopCalls).toHaveLength(0);
    });

    it("works without whoopBle deps (optional)", async () => {
      const depsWithoutWhoop = makeMockDeps();
      delete depsWithoutWhoop.whoopBle;
      const serviceWithoutWhoop = createInertialMeasurementUnitService(depsWithoutWhoop);

      await expect(serviceWithoutWhoop.ensureRecording()).resolves.toBeUndefined();
      await expect(
        serviceWithoutWhoop.syncForTimeRange(startedAt, endedAt),
      ).resolves.toBeUndefined();
    });
  });
});
