import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccelerometerSample } from "../modules/core-motion";

const mockIsWatchPaired = vi.fn(() => true);
const mockIsWatchAppInstalled = vi.fn(() => true);
const mockGetPendingWatchSamples = vi.fn(() => Promise.resolve([]));
const mockAcknowledgeWatchSamples = vi.fn();
const mockGetLastWatchSyncTimestamp = vi.fn((): string | null => null);
const mockSetLastWatchSyncTimestamp = vi.fn();
const mockRequestWatchRecording = vi.fn(() => Promise.resolve(true));

vi.mock("../modules/watch-motion", () => ({
  isWatchPaired: () => mockIsWatchPaired(),
  isWatchAppInstalled: () => mockIsWatchAppInstalled(),
  getPendingWatchSamples: () => mockGetPendingWatchSamples(),
  acknowledgeWatchSamples: () => mockAcknowledgeWatchSamples(),
  getLastWatchSyncTimestamp: () => mockGetLastWatchSyncTimestamp(),
  setLastWatchSyncTimestamp: (timestamp: string) => mockSetLastWatchSyncTimestamp(timestamp),
  requestWatchRecording: () => mockRequestWatchRecording(),
}));

import { createWatchCoreMotionAdapter } from "./watch-accelerometer-adapter.ts";

describe("WatchCoreMotionAdapter", () => {
  let adapter: ReturnType<typeof createWatchCoreMotionAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWatchPaired.mockReturnValue(true);
    mockIsWatchAppInstalled.mockReturnValue(true);
    adapter = createWatchCoreMotionAdapter();
  });

  describe("isAccelerometerRecordingAvailable", () => {
    it("returns true when Watch is paired and app is installed", () => {
      expect(adapter.isAccelerometerRecordingAvailable()).toBe(true);
    });

    it("returns false when Watch is not paired", () => {
      mockIsWatchPaired.mockReturnValue(false);
      adapter = createWatchCoreMotionAdapter();
      expect(adapter.isAccelerometerRecordingAvailable()).toBe(false);
    });

    it("returns false when Watch app is not installed", () => {
      mockIsWatchAppInstalled.mockReturnValue(false);
      adapter = createWatchCoreMotionAdapter();
      expect(adapter.isAccelerometerRecordingAvailable()).toBe(false);
    });
  });

  describe("queryRecordedData", () => {
    it("returns samples from pending Watch files", async () => {
      const mockSamples: AccelerometerSample[] = [
        { timestamp: "2026-03-25T10:00:00.000Z", x: 0.01, y: -0.98, z: 0.04 },
        { timestamp: "2026-03-25T10:00:00.020Z", x: 0.02, y: -0.97, z: 0.05 },
      ];
      mockGetPendingWatchSamples.mockResolvedValue(mockSamples);

      const result = await adapter.queryRecordedData(
        "2026-03-25T00:00:00Z",
        "2026-03-25T23:59:59Z",
      );

      expect(result).toEqual(mockSamples);
      expect(mockGetPendingWatchSamples).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when no pending files", async () => {
      mockGetPendingWatchSamples.mockResolvedValue([]);

      const result = await adapter.queryRecordedData(
        "2026-03-25T00:00:00Z",
        "2026-03-25T23:59:59Z",
      );

      expect(result).toEqual([]);
    });
  });

  describe("getLastSyncTimestamp", () => {
    it("delegates to watch-motion module", () => {
      mockGetLastWatchSyncTimestamp.mockReturnValue("2026-03-25T10:00:00Z");
      expect(adapter.getLastSyncTimestamp()).toBe("2026-03-25T10:00:00Z");
    });

    it("returns null when never synced", () => {
      mockGetLastWatchSyncTimestamp.mockReturnValue(null);
      expect(adapter.getLastSyncTimestamp()).toBeNull();
    });
  });

  describe("setLastSyncTimestamp", () => {
    it("sets timestamp and acknowledges pending files", () => {
      adapter.setLastSyncTimestamp("2026-03-25T12:00:00Z");

      expect(mockSetLastWatchSyncTimestamp).toHaveBeenCalledWith("2026-03-25T12:00:00Z");
      expect(mockAcknowledgeWatchSamples).toHaveBeenCalledTimes(1);
    });
  });

  describe("startRecording", () => {
    it("requests Watch to record and sync, returns true", async () => {
      mockRequestWatchRecording.mockResolvedValue(true);

      const result = await adapter.startRecording(43200);

      expect(result).toBe(true);
      expect(mockRequestWatchRecording).toHaveBeenCalledTimes(1);
    });

    it("returns true even if Watch is not reachable", async () => {
      mockRequestWatchRecording.mockResolvedValue(false);

      const result = await adapter.startRecording(43200);

      // Still returns true — the Watch records autonomously
      expect(result).toBe(true);
    });
  });

  describe("isRecordingActive", () => {
    it("returns true when Watch is paired and app installed", () => {
      expect(adapter.isRecordingActive()).toBe(true);
    });

    it("returns false when Watch is not paired", () => {
      mockIsWatchPaired.mockReturnValue(false);
      adapter = createWatchCoreMotionAdapter();
      expect(adapter.isRecordingActive()).toBe(false);
    });
  });
});
