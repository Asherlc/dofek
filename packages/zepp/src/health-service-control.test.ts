import { describe, expect, it, vi } from "vitest";
import { ensureHealthServiceRunning } from "./health-service-control.ts";

describe("ensureHealthServiceRunning", () => {
  it("starts immediately when background permission is already granted", async () => {
    const requestPermission = vi.fn<() => Promise<number>>();
    const startService = vi.fn();

    await expect(
      ensureHealthServiceRunning({
        queryPermission: () => 2,
        requestPermission,
        startService,
      }),
    ).resolves.toEqual({ state: "started" });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(startService).toHaveBeenCalledOnce();
  });

  it("requests permission and starts after the request is granted", async () => {
    const startService = vi.fn();

    await expect(
      ensureHealthServiceRunning({
        queryPermission: () => 0,
        requestPermission: vi.fn(async () => 2),
        startService,
      }),
    ).resolves.toEqual({ state: "started" });

    expect(startService).toHaveBeenCalledOnce();
  });

  it("returns an actionable state and does not start when permission is denied", async () => {
    const startService = vi.fn();

    await expect(
      ensureHealthServiceRunning({
        queryPermission: () => 0,
        requestPermission: vi.fn(async () => 1),
        startService,
      }),
    ).resolves.toEqual({
      state: "permission-denied",
      reason: "Background health collection requires Background Service permission.",
    });

    expect(startService).not.toHaveBeenCalled();
  });

  it("propagates unexpected permission and service failures", async () => {
    const permissionError = new Error("permission API unavailable");
    await expect(
      ensureHealthServiceRunning({
        queryPermission: () => {
          throw permissionError;
        },
        requestPermission: vi.fn(),
        startService: vi.fn(),
      }),
    ).rejects.toBe(permissionError);

    const serviceError = new Error("service start failed");
    await expect(
      ensureHealthServiceRunning({
        queryPermission: () => 2,
        requestPermission: vi.fn(),
        startService: () => {
          throw serviceError;
        },
      }),
    ).rejects.toBe(serviceError);
  });
});
