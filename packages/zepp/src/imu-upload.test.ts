import { describe, expect, it } from "vitest";
import { createImuChunkEnvelope, parseImuEnvelope } from "./imu-upload.ts";

function validEnvelope() {
  return createImuChunkEnvelope({
    connectionType: "zepp",
    installId: "install-1",
    segmentId: "segment-1",
    sessionStartMs: 1_720_000_000_000,
    samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
  });
}

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

  it.each([
    { installId: " ", segmentId: "segment-1", sessionStartMs: 1_720_000_000_000 },
    { installId: "install-1", segmentId: " ", sessionStartMs: 1_720_000_000_000 },
    { installId: "install-1", segmentId: "segment-1", sessionStartMs: 1.5 },
  ])("rejects invalid chunk metadata %#", ({ installId, segmentId, sessionStartMs }) => {
    expect(() =>
      createImuChunkEnvelope({
        connectionType: "zepp",
        installId,
        segmentId,
        sessionStartMs,
        samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
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
    expect(envelope.events[0]?.createdAt).toBe("2024-07-03T09:46:40.040Z");
    expect(parseImuEnvelope(envelope)).toEqual(envelope);
  });

  it("preserves an explicit accelerometer-only marker", () => {
    const envelope = createImuChunkEnvelope({
      connectionType: "zepp",
      installId: "install-1",
      segmentId: "segment-1",
      sessionStartMs: 0,
      hasGyroscope: false,
      samples: [{ tMs: 0, ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 }],
    });

    expect(envelope.events[0]?.createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(envelope.events[0]?.payload.hasGyroscope).toBe(false);
  });

  it.each([
    null,
    [],
    "invalid",
    { ...validEnvelope(), version: 2 },
    { ...validEnvelope(), batchId: 1 },
    { ...validEnvelope(), batchId: " " },
    { ...validEnvelope(), source: null },
    { ...validEnvelope(), source: { connectionType: "other", installId: "install-1" } },
    { ...validEnvelope(), source: { connectionType: "zepp", installId: 1 } },
    { ...validEnvelope(), source: { connectionType: "zepp", installId: " " } },
    { ...validEnvelope(), events: {} },
    { ...validEnvelope(), events: [] },
  ])("rejects invalid envelope metadata %#", (value) => {
    expect(() => parseImuEnvelope(value)).toThrow("IMU envelope is invalid.");
  });

  it.each([
    null,
    [],
    "invalid",
    { ...validEnvelope().events[0], eventId: 1 },
    { ...validEnvelope().events[0], eventId: " " },
    { ...validEnvelope().events[0], createdAt: 1 },
    { ...validEnvelope().events[0], createdAt: " " },
    { ...validEnvelope().events[0], payload: null },
    {
      ...validEnvelope().events[0],
      payload: { ...validEnvelope().events[0]?.payload, segmentId: 1 },
    },
    {
      ...validEnvelope().events[0],
      payload: { ...validEnvelope().events[0]?.payload, segmentId: " " },
    },
    {
      ...validEnvelope().events[0],
      payload: { ...validEnvelope().events[0]?.payload, sessionStartMs: 1.5 },
    },
    {
      ...validEnvelope().events[0],
      payload: { ...validEnvelope().events[0]?.payload, hasGyroscope: "true" },
    },
    {
      ...validEnvelope().events[0],
      payload: { ...validEnvelope().events[0]?.payload, samples: {} },
    },
    {
      ...validEnvelope().events[0],
      payload: { ...validEnvelope().events[0]?.payload, samples: [] },
    },
  ])("rejects invalid envelope events %#", (event) => {
    expect(() => parseImuEnvelope({ ...validEnvelope(), events: [event] })).toThrow(
      "IMU envelope is invalid.",
    );
  });

  it.each([
    null,
    [],
    "invalid",
    { tMs: "0", ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 },
    { tMs: 0.5, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 },
    { tMs: -1, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 },
    { tMs: 0, ax: Number.NaN, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 },
    { tMs: 0, ax: 1, ay: Number.NaN, az: 3, gx: 4, gy: 5, gz: 6 },
    { tMs: 0, ax: 1, ay: 2, az: Number.NaN, gx: 4, gy: 5, gz: 6 },
    { tMs: 0, ax: 1, ay: 2, az: 3, gx: Number.NaN, gy: 5, gz: 6 },
    { tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: Number.NaN, gz: 6 },
    { tMs: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: Number.NaN },
  ])("rejects invalid persisted samples %#", (sample) => {
    const envelope = validEnvelope();
    const event = envelope.events[0];
    if (!event) throw new Error("Expected a valid fixture event.");
    expect(() =>
      parseImuEnvelope({
        ...envelope,
        events: [{ ...event, payload: { ...event.payload, samples: [sample] } }],
      }),
    ).toThrow("IMU envelope is invalid.");
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
