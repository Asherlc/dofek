import { describe, expect, it, vi } from "vitest";
import {
  acquireForegroundHealthOwnership,
  ensureHealthServiceRunning,
} from "./health-service-control.ts";

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

describe("acquireForegroundHealthOwnership", () => {
  it("waits for App Service shutdown before granting foreground ownership", async () => {
    let completeStop: (() => void) | undefined;
    const stopService = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeStop = resolve;
        }),
    );
    const startService = vi.fn();
    let ownsOutbox = false;

    const acquisition = acquireForegroundHealthOwnership({
      queryPermission: () => 2,
      requestPermission: vi.fn(),
      stopService,
      startService,
    }).then((ownership) => {
      ownsOutbox = true;
      return ownership;
    });

    await Promise.resolve();
    expect(ownsOutbox).toBe(false);
    completeStop?.();
    const ownership = await acquisition;
    expect(ownsOutbox).toBe(true);

    ownership.release();
    ownership.release();
    expect(startService).toHaveBeenCalledOnce();
  });

  it("grants foreground-only ownership without stopping or restarting when permission is denied", async () => {
    const stopService = vi.fn();
    const startService = vi.fn();

    const ownership = await acquireForegroundHealthOwnership({
      queryPermission: () => 0,
      requestPermission: vi.fn(async () => 1),
      stopService,
      startService,
    });

    expect(ownership.state).toBe("permission-denied");
    expect(stopService).not.toHaveBeenCalled();
    ownership.release();
    expect(startService).not.toHaveBeenCalled();
  });

  it("preserves the last background append before a foreground drain starts", async () => {
    let completeStop: (() => void) | undefined;
    const stored = ["background-before-stop"];
    const acquisition = acquireForegroundHealthOwnership({
      queryPermission: () => 2,
      requestPermission: vi.fn(),
      stopService: () =>
        new Promise<void>((resolve) => {
          completeStop = resolve;
        }),
      startService: vi.fn(),
    });

    stored.push("background-during-stop");
    completeStop?.();
    await acquisition;
    stored.push("foreground-after-stop");

    expect(stored).toEqual([
      "background-before-stop",
      "background-during-stop",
      "foreground-after-stop",
    ]);
  });
});
