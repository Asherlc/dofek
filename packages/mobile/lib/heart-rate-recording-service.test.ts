import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BleHeartRateSample } from "../modules/ble-heart-rate";
import {
  createHeartRateRecordingService,
  type HeartRateRecordingServiceDeps,
} from "./heart-rate-recording-service.ts";

const { mockLoadDeviceErasureCutoff } = vi.hoisted(() => ({
  mockLoadDeviceErasureCutoff: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("./device-erasure-cutoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-erasure-cutoff")>();
  return {
    ...actual,
    loadDeviceErasureCutoff: mockLoadDeviceErasureCutoff,
  };
});

const START = "2026-03-30T11:00:00.000Z";
const END = "2026-03-30T13:00:00.000Z";

function sampleAt(timestamp: string, bpm = 140): BleHeartRateSample {
  return { deviceId: "Polar H10", timestamp, heartRateBpm: bpm, rrIntervalsMs: [] };
}

/** An in-window sample (between START and END). */
function sample(bpm: number): BleHeartRateSample {
  return sampleAt("2026-03-30T12:00:00.000Z", bpm);
}

function sampleForDevice(deviceId: string, bpm: number): BleHeartRateSample {
  return { ...sample(bpm), deviceId };
}

function makeDeps(): HeartRateRecordingServiceDeps {
  return {
    ble: {
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
    mockLoadDeviceErasureCutoff.mockResolvedValue(null);
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
    it("uploads a buffered sample under its captured device ID without a selected monitor", async () => {
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([sampleForDevice("polar", 140)])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "polar",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRateBpm: 140,
            rrIntervalsMs: [],
          },
        ],
      });
    });

    it("leaves a blank-device sample buffered instead of assigning it to another device", async () => {
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue([sampleForDevice("   ", 140)]);

      await expect(
        createHeartRateRecordingService(deps).syncForTimeRange(START, END),
      ).rejects.toThrow("Buffered sample is missing deviceId");

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).not.toHaveBeenCalled();
      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });

    it("leaves a sample without a device ID buffered instead of assigning it to another device", async () => {
      const sampleWithoutDeviceId = {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 140,
        rrIntervalsMs: [],
      };
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue([sampleWithoutDeviceId]);

      await expect(
        createHeartRateRecordingService(deps).syncForTimeRange(START, END),
      ).rejects.toThrow("Buffered sample is missing deviceId");

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).not.toHaveBeenCalled();
      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });

    it("uploads in-window samples and confirms the drain on success", async () => {
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([sample(140), sample(141)])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Polar H10",
        samples: [
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRateBpm: 140,
            rrIntervalsMs: [],
          },
          {
            timestamp: "2026-03-30T12:00:00.000Z",
            heartRateBpm: 141,
            rrIntervalsMs: [],
          },
        ],
      });
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
    });

    it("groups buffered samples by captured device id before upload", async () => {
      const strapA1 = sampleForDevice("strap-a", 140);
      const strapB = sampleForDevice("strap-b", 141);
      const strapA2 = sampleForDevice("strap-a", 142);
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([strapA1, strapB, strapA2])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenNthCalledWith(1, {
        deviceId: "strap-a",
        samples: [
          {
            timestamp: strapA1.timestamp,
            heartRateBpm: strapA1.heartRateBpm,
            rrIntervalsMs: [],
          },
          {
            timestamp: strapA2.timestamp,
            heartRateBpm: strapA2.heartRateBpm,
            rrIntervalsMs: [],
          },
        ],
      });
      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenNthCalledWith(2, {
        deviceId: "strap-b",
        samples: [
          {
            timestamp: strapB.timestamp,
            heartRateBpm: strapB.heartRateBpm,
            rrIntervalsMs: [],
          },
        ],
      });
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(3);
    });

    it("leaves a mixed-device page buffered when one device upload fails", async () => {
      const strapA = sampleForDevice("strap-a", 140);
      const strapB = sampleForDevice("strap-b", 141);
      vi.mocked(deps.ble.peekBufferedSamples).mockResolvedValue([strapA, strapB]);
      vi.mocked(deps.trpcClient.bleHeartRateSync.pushSamples.mutate)
        .mockResolvedValueOnce({ inserted: 1 })
        .mockRejectedValueOnce(new Error("network"));

      await expect(
        createHeartRateRecordingService(deps).syncForTimeRange(START, END),
      ).rejects.toThrow("network");

      expect(deps.ble.confirmSamplesDrain).not.toHaveBeenCalled();
    });

    it("does not gate on live Bluetooth state when buffered samples identify their device", async () => {
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
        samples: [{ timestamp: inWindow.timestamp, heartRateBpm: 140, rrIntervalsMs: [] }],
      });
      // Both pre-window and in-window are consumed from the buffer.
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
    });

    it("drains old-account samples and uploads only samples strictly after the cutoff", async () => {
      const cutoff = "2026-03-30T12:00:00.000Z";
      const retained = sampleAt("2026-03-30T12:00:01.000Z", 141);
      mockLoadDeviceErasureCutoff.mockResolvedValue(cutoff);
      vi.mocked(deps.ble.peekBufferedSamples)
        .mockResolvedValueOnce([sampleAt(cutoff, 60), retained])
        .mockResolvedValue([]);

      await createHeartRateRecordingService(deps).syncForTimeRange(START, END);

      expect(deps.trpcClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "Polar H10",
        samples: [{ timestamp: retained.timestamp, heartRateBpm: 141, rrIntervalsMs: [] }],
      });
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
        samples: [
          { timestamp: inFirst.timestamp, heartRateBpm: 140, rrIntervalsMs: [] },
          { timestamp: inLast.timestamp, heartRateBpm: 141, rrIntervalsMs: [] },
        ],
      });
      // Only the two in-window samples drain; the post-window one stays buffered.
      expect(deps.ble.confirmSamplesDrain).toHaveBeenCalledWith(2);
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
