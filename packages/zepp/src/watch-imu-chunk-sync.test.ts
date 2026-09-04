import { describe, expect, it, vi } from "vitest";
import { deliverImuChunk } from "./watch-imu-chunk-sync.ts";

const input = {
  connectionType: "zepp" as const,
  installId: "install-1",
  segmentId: "segment-1",
  sessionStartMs: 1_720_000_000_000,
  hasGyroscope: true,
  samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
};

describe("deliverImuChunk", () => {
  it("uses the versioned envelope and requires a durable phone acknowledgement", async () => {
    const request = vi.fn(async (envelope) => ({
      status: "ok",
      acceptedEventIds: envelope.events.map((event: { eventId: string }) => event.eventId),
      rejected: [],
    }));

    await expect(deliverImuChunk(input, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "segment-1:0:0", version: 1 }),
    );
  });

  it("reports a missing phone acknowledgement", async () => {
    await expect(
      deliverImuChunk(input, async () => ({ status: "ok", acceptedEventIds: [], rejected: [] })),
    ).rejects.toThrow("Phone did not persist the IMU chunk.");
  });
});
