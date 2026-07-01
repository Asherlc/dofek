import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BleHeartRateSample } from "../modules/ble-heart-rate";
import {
  createHeartRateRecordingService,
  type HeartRateRecordingServiceDeps,
} from "./heart-rate-recording-service.ts";

function sample(bpm: number): BleHeartRateSample {
  return { timestamp: "2026-03-30T12:00:00.000Z", heartRateBpm: bpm, rrIntervalsMs: [] };
}

function makeDeps(): HeartRateRecordingServiceDeps {
  return {
    ble: {
      isAvailable: vi.fn().mockReturnValue(true),
      getDeviceId: vi.fn().mockReturnValue("Polar H10"),
      peekBufferedSamples: vi.fn().mockResolvedValue([]),
      confirmSamplesDrain: vi.fn(),
    },
    trpcClient: {
      bleHeartRateSync: {
        pushSamples: {
          mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
        },
      },
    },
  };
}

describe("createHeartRateRecordingService", () => {
  let deps: HeartRateRecordingServiceDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("ensureRecording", () => {
    it("is a no-op (connection is UI-driven)", async () => {
      await expect(
        createHeartRateRecordingService(deps).ensureRecording(),
      ).resolves.toBeUndefined();
    });
  });

  describe("syncForTimeRange", () => {
    it("uploads buffered samples and confirms the drain on success", async () => {
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue([sample(140), sample(141)]);

      await createHeartRateRecordingService(deps).syncForTimeRange("start", "end");

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Polar H10",
        samples: [sample(140), sample(141)],
      });
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
    });

    it("does nothing when Bluetooth is unavailable", async () => {
      vi.mocked(deps.ble.isAvailable).mockReturnValue(false);

      await createHeartRateRecordingService(deps).syncForTimeRange("start", "end");

      expect(deps.ble.peekBufferedSamples).not.toHaveBeenCalled();
      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).not.toHaveBeenCalled();
    });

    it("does nothing when no monitor is connected", async () => {
      vi.mocked(deps.ble.getDeviceId).mockReturnValue(null);

      await createHeartRateRecordingService(deps).syncForTimeRange("start", "end");

      expect(deps.ble.peekBufferedSamples).not.toHaveBeenCalled();
    });

    it("does not upload or drain when there are no buffered samples", async () => {
      await createHeartRateRecordingService(deps).syncForTimeRange("start", "end");

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).not.toHaveBeenCalled();
      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });

    it("splits large sample sets into batches", async () => {
      const samples = Array.from({ length: 12000 }, () => sample(140));
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue(samples);

      await createHeartRateRecordingService(deps).syncForTimeRange("start", "end");

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledTimes(3);
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(12000);
    });

    it("leaves samples buffered (no drain) when upload fails", async () => {
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue([sample(140)]);
      vi.mocked(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).mockRejectedValue(
        new Error("network"),
      );

      await expect(
        createHeartRateRecordingService(deps).syncForTimeRange("start", "end"),
      ).rejects.toThrow("network");

      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });
  });
});
