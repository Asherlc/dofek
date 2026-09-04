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

    const asynchronousServiceError = new Error("service callback failed");
    await expect(
      ensureHealthServiceRunning({
        queryPermission: () => 2,
        requestPermission: vi.fn(),
        startService: async () => {
          throw asynchronousServiceError;
        },
      }),
    ).rejects.toBe(asynchronousServiceError);
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

  it("waits for the final foreground mutation before restarting App Service", async () => {
    let completeDrain: (() => void) | undefined;
    const drain = new Promise<void>((resolve) => {
      completeDrain = resolve;
    });
    const startService = vi.fn();
    const ownership = await acquireForegroundHealthOwnership({
      queryPermission: () => 2,
      requestPermission: vi.fn(),
      stopService: vi.fn(async () => undefined),
      startService,
    });

    const release = ownership.release(drain);
    await Promise.resolve();
    expect(startService).not.toHaveBeenCalled();

    completeDrain?.();
    await release;
    expect(startService).toHaveBeenCalledOnce();
  });

  it("restarts App Service after a rejected foreground mutation and preserves the rejection", async () => {
    const mutationError = new Error("foreground outbox write failed");
    const startService = vi.fn();
    const ownership = await acquireForegroundHealthOwnership({
      queryPermission: () => 2,
      requestPermission: vi.fn(),
      stopService: vi.fn(async () => undefined),
      startService,
    });

    await expect(ownership.release(Promise.reject(mutationError))).rejects.toBe(mutationError);
    expect(startService).toHaveBeenCalledOnce();
  });

  it("waits for an asynchronous App Service restart and surfaces its failure", async () => {
    const restartError = new Error("health service callback failed");
    const ownership = await acquireForegroundHealthOwnership({
      queryPermission: () => 2,
      requestPermission: vi.fn(),
      stopService: vi.fn(async () => undefined),
      startService: async () => {
        throw restartError;
      },
    });

    await expect(ownership.release()).rejects.toBe(restartError);
  });
});
