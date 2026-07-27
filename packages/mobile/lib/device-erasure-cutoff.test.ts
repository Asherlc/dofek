import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceDeviceErasureCutoff,
  DEVICE_ERASURE_CUTOFF_KEY,
  isAfterDeviceErasureCutoff,
  loadDeviceErasureCutoff,
} from "./device-erasure-cutoff";

describe("device erasure cutoff", () => {
  beforeEach(async () => {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.deleteItemAsync(DEVICE_ERASURE_CUTOFF_KEY);
  });

  it("persists a monotonic cutoff across a later account", async () => {
    await advanceDeviceErasureCutoff("2026-07-26T12:00:00.000Z");

    expect(await advanceDeviceErasureCutoff("2026-07-25T12:00:00.000Z")).toBe(
      "2026-07-26T12:00:00.000Z",
    );
    expect(await loadDeviceErasureCutoff()).toBe("2026-07-26T12:00:00.000Z");
  });

  it("accepts only samples strictly after the cutoff", () => {
    const cutoff = "2026-07-26T12:00:00.000Z";

    expect(isAfterDeviceErasureCutoff("2026-07-26T12:00:00.001Z", cutoff)).toBe(true);
    expect(isAfterDeviceErasureCutoff(cutoff, cutoff)).toBe(false);
    expect(isAfterDeviceErasureCutoff("2026-07-26T11:59:59.999Z", cutoff)).toBe(false);
    expect(isAfterDeviceErasureCutoff("not-a-date", cutoff)).toBe(false);
    expect(isAfterDeviceErasureCutoff("2026-07-26T12:00:00.001Z", "not-a-date")).toBe(false);
  });

  it("fails closed when the durable cutoff is malformed", async () => {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(DEVICE_ERASURE_CUTOFF_KEY, "not-a-date");

    await expect(loadDeviceErasureCutoff()).rejects.toThrow(
      "Stored device erasure cutoff is invalid",
    );
  });
});
