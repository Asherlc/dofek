import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOptionalNativeModule = vi.hoisted(() => vi.fn());

vi.mock("expo", () => ({
  requireOptionalNativeModule,
}));

describe("@dofek/oura-ble portable entry", () => {
  it("imports without requiring expo or native modules", async () => {
    vi.resetModules();
    requireOptionalNativeModule.mockReset();

    const mod = await import("./index.js");

    expect(mod).toBeTypeOf("object");
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });
});

describe("@dofek/oura-ble/expo", () => {
  beforeEach(() => {
    vi.resetModules();
    requireOptionalNativeModule.mockReset();
  });

  it("throws an actionable error when the native module is unavailable", async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const { createExpoOuraClient } = await import("./expo.js");
    const client = createExpoOuraClient();

    await expect(client.discoverRings()).rejects.toThrow(/OuraBle/);
    await expect(client.discoverRings()).rejects.toThrow(/Rebuild your iOS/);
    expect(requireOptionalNativeModule).toHaveBeenCalledWith("OuraBle");
  });

  it("forwards discoverRings to the native module", async () => {
    const native = {
      rings: [{ peripheralId: "p1", name: "Oura" }],
      discoverRings: vi.fn(async function (this: {
        rings: { peripheralId: string; name: string }[];
      }) {
        return this.rings;
      }),
    };
    requireOptionalNativeModule.mockReturnValue(native);
    const { createExpoOuraClient } = await import("./expo.js");

    await expect(createExpoOuraClient().discoverRings()).resolves.toEqual([
      { peripheralId: "p1", name: "Oura" },
    ]);
    expect(native.discoverRings).toHaveBeenCalledWith();
  });

  it("forwards pairRing parameters and returns pairing result", async () => {
    const result = {
      ringId: "ring-123",
      deviceInfo: { model: "Gen3", firmwareVersion: "2.0.0", serialNumber: "EXAMPLE" },
      measurementOutcomes: [{ setting: "heart_rate", accepted: true }],
    };
    const native = {
      pairRing: vi.fn().mockResolvedValue(result),
    };
    requireOptionalNativeModule.mockReturnValue(native);
    const { createExpoOuraClient } = await import("./expo.js");
    const options = { requestedMeasurements: ["heart_rate"] };

    await expect(createExpoOuraClient().pairRing("p1", options)).resolves.toEqual(result);
    expect(native.pairRing).toHaveBeenCalledWith("p1", options);
  });

  it("forwards syncRing, readEvents, and forgetRing parameters", async () => {
    const page = {
      events: [
        {
          ringId: "ring-123",
          tag: 65,
          eventType: "sleep",
          ringRelativeTimestamp: { value: 42, unit: "ticks" },
          captureTime: "2026-11-19T00:00:00.000Z",
          decodedFields: { score: 80 },
          rawBodyBase64: "AQID",
        },
      ],
      nextPageToken: "opaque-token-2",
    };
    const native = {
      syncRing: vi.fn().mockResolvedValue({ ringId: "ring-123", syncedEventCount: 1 }),
      readEvents: vi.fn().mockResolvedValue(page),
      forgetRing: vi.fn().mockResolvedValue(undefined),
    };
    requireOptionalNativeModule.mockReturnValue(native);
    const { createExpoOuraClient } = await import("./expo.js");
    const client = createExpoOuraClient();

    await expect(client.syncRing("ring-123")).resolves.toEqual({
      ringId: "ring-123",
      syncedEventCount: 1,
    });
    expect(native.syncRing).toHaveBeenCalledWith("ring-123");

    await expect(client.readEvents("ring-123", { pageToken: "t1", limit: 50 })).resolves.toEqual(
      page,
    );
    expect(native.readEvents).toHaveBeenCalledWith("ring-123", { pageToken: "t1", limit: 50 });

    await expect(client.forgetRing("ring-123")).resolves.toBeUndefined();
    expect(native.forgetRing).toHaveBeenCalledWith("ring-123");
  });

  it("forwards native rejections unchanged", async () => {
    const rejection = new Error("native bluetooth failure");
    const native = {
      discoverRings: vi.fn().mockRejectedValue(rejection),
    };
    requireOptionalNativeModule.mockReturnValue(native);
    const { createExpoOuraClient } = await import("./expo.js");

    await expect(createExpoOuraClient().discoverRings()).rejects.toBe(rejection);
  });
});
