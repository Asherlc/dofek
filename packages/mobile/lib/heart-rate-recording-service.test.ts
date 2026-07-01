import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BleHeartRateSample } from "../modules/ble-heart-rate";
import {
  createHeartRateRecordingService,
  type HeartRateRecordingServiceDeps,
} from "./heart-rate-recording-service.ts";

const START = "2026-03-30T11:00:00.000Z";
const END = "2026-03-30T13:00:00.000Z";

function sampleAt(timestamp: string, bpm = 140): BleHeartRateSample {
  return { timestamp, heartRateBpm: bpm, rrIntervalsMs: [] };
}

/** An in-window sample (between START and END). */
function sample(bpm: number): BleHeartRateSample {
  return sampleAt("2026-03-30T12:00:00.000Z", bpm);
}

function makeDeps(): HeartRateRecordingServiceDeps {
  return {
    ble: {
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
    it("is a no-op — windowing happens at sync, not start", async () => {
      await createHeartRateRecordingService(deps).ensureRecording();

      expect(deps.ble.peekBufferedSamples).not.toHaveBeenCalled();
      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });
  });

  describe("syncForTimeRange", () => {
    it("uploads in-window samples and confirms the drain on success", async () => {
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([sample(140), sample(141)])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Polar H10",
        samples: [sample(140), sample(141)],
      });
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
    });

    it("does not gate on live Bluetooth state — a persisted device ID is enough", async () => {
      // No isAvailable dependency exists; uploads proceed whenever a device ID
      // is known, even if the radio is off at save time.
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([sample(140)])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(1);
    });

    it("drains repeatedly until the buffer is empty (multiple pages)", async () => {
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([sample(140), sample(141)])
        .mockResolvedValueOnce([sample(142)])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
      expect(deps.ble.confirmSamplesDrain).toHaveBeenNthCalledWith(1, 2);
      expect(deps.ble.confirmSamplesDrain).toHaveBeenNthCalledWith(2, 1);
    });

    it("drains but does not upload samples before startedAt", async () => {
      const preStart = sampleAt("2026-03-30T10:59:59.000Z", 60);
      const inWindow = sampleAt("2026-03-30T12:00:00.000Z", 140);
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([preStart, inWindow])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Polar H10",
        samples: [inWindow],
      });
      // Both pre-window and in-window are consumed from the buffer.
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
    });

    it("stops at the endedAt boundary and leaves post-window samples buffered", async () => {
      const inFirst = sampleAt("2026-03-30T12:00:00.000Z", 140);
      const inLast = sampleAt("2026-03-30T13:00:00.000Z", 141);
      const afterEnd = sampleAt("2026-03-30T13:00:01.000Z", 142);
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValueOnce([inFirst, inLast, afterEnd]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Polar H10",
        samples: [inFirst, inLast],
      });
      // Only the two in-window samples drain; the post-window one stays buffered.
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
    });

    it("does nothing when no monitor has ever connected", async () => {
      vi.mocked(deps.ble.getDeviceId).mockReturnValue(null);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.ble.peekBufferedSamples).not.toHaveBeenCalled();
    });

    it("does not upload or drain when there are no buffered samples", async () => {
      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).not.toHaveBeenCalled();
      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });

    it("splits a large in-window page into upload batches", async () => {
      const samples = Array.from({ length: 12000 }, () => sample(140));
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValueOnce(samples).mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledTimes(3);
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(12000);
    });

    it("leaves samples buffered (no drain) when upload fails", async () => {
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue([sample(140)]);
      vi.mocked(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).mockRejectedValue(
        new Error("network"),
      );

      await expect(
        createHeartRateRecordingService(deps).syncForTimeRange(START, END),
      ).rejects.toThrow("network");

      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });
  });
});
