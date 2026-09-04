import { describe, expect, it } from "vitest";
import { createImuChunkEnvelope, parseImuEnvelope } from "./imu-upload.ts";

describe("IMU upload envelope", () => {
  it("rejects invalid sample values before creating an envelope", () => {
    expect(() =>
      createImuChunkEnvelope({
        connectionType: "zepp",
        installId: "install-1",
        segmentId: "segment-1",
        sessionStartMs: 1_720_000_000_000,
        samples: [{ tMs: -1, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: Number.NaN }],
      }),
    ).toThrow("IMU envelope is invalid.");
  });
  it("creates a stable chunk identity and round-trips the payload", () => {
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-1",
      sessionStartMs: 1_720_000_000_000,
      samples: [
        { tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 },
        { tMs: 40, ax: 7, ay: 8, az: 9, gx: 10, gy: 11, gz: 12 },
      ],
    });

    expect(envelope.batchId).toBe("segment-1:0:40");
    expect(envelope.events[0]?.eventId).toBe("segment-1:0:40");
    expect(parseImuEnvelope(envelope)).toEqual(envelope);
  });

  it("rejects malformed samples before phone persistence", () => {
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-1",
      sessionStartMs: 1_720_000_000_000,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
    });
    const malformed = {
      ...envelope,
      events: envelope.events.map((event) => ({
        ...event,
        payload: { ...event.payload, samples: [{ tMs: -1, ax: 1, ay: 2, az: 3 }] },
      })),
    };

    expect(() => parseImuEnvelope(malformed)).toThrow("IMU envelope is invalid.");
  });
});
