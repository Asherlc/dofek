import { describe, expect, it, vi } from "vitest";
import type { DisplayLease } from "./display-lease.ts";
import { createImuSessionController } from "./imu-session-controller.ts";
import type { CollectorOptions, ImuCollector, ImuSample } from "./types.ts";

function setup(
  options: {
    appendError?: Error;
    resetError?: Error;
    stopError?: Error;
    hasGyro?: boolean;
  } = {},
) {
  let collectorOptions: CollectorOptions | undefined;
  const collector: ImuCollector = {
    available: true,
    hasGyroscope: options.hasGyro ?? true,
    accelMode: 1,
    gyroMode: options.hasGyro === false ? null : 1,
    getStats: () => ({ sampleCount: 0, observedHzX100: 0, sessionStartMs: 0 }),
    start: vi.fn(),
    stop: vi.fn(() => {
      if (options.stopError) throw options.stopError;
    }),
  };
  const lease: DisplayLease = {
    acquired: false,
    acquire: vi.fn(),
    release: vi.fn(),
  };
  const file = {
    reset: vi.fn(() => {
      if (options.resetError) throw options.resetError;
    }),
    append: vi.fn(() => {
      if (options.appendError) throw options.appendError;
    }),
    finalize: vi.fn(),
  };
  const onError = vi.fn();
  const controller = createImuSessionController({
    path: "data://imu/session_a.bin",
    requestedFreqModeIndex: 1,
    flushThreshold: 2,
    now: () => 1_720_000_000_000,
    displayLease: lease,
    createCollector: (value) => {
      collectorOptions = value;
      return collector;
    },
    file,
    onError,
  });
  const emit = (sample: ImuSample) => {
    if (!collectorOptions) throw new Error("collector options missing");
    collectorOptions.onSample(sample);
  };
  const status = (sampleCount: number, observedHzX100: number) => {
    if (!collectorOptions?.onStatus) throw new Error("collector status handler missing");
    collectorOptions.onStatus({ sampleCount, observedHzX100 });
  };
  return { collector, controller, emit, file, lease, onError, status };
}

const sample: ImuSample = { tMs: 1, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 };

describe("createImuSessionController", () => {
  it("starts an automatic gyro-capable segment with a display lease and canonical header", () => {
    const { collector, controller, file, lease } = setup();

    expect(controller.start()).toBe(true);
    expect(lease.acquire).toHaveBeenCalledOnce();
    expect(file.reset).toHaveBeenCalledWith(
      expect.objectContaining({
        hasGyro: true,
        sessionStartMs: 1_720_000_000_000,
        accelFreqMode: 1,
        gyroFreqMode: 1,
      }),
      "data://imu/session_a.bin",
    );
    expect(collector.start).toHaveBeenCalledOnce();
  });

  it("falls back to accelerometer-only and flushes/finalizes once", () => {
    const { collector, controller, emit, file, lease, status } = setup({ hasGyro: false });
    controller.start();
    emit(sample);
    emit({ ...sample, tMs: 2 });
    status(2, 2_500);

    expect(file.append).toHaveBeenCalledWith(
      [sample, { ...sample, tMs: 2 }],
      false,
      "data://imu/session_a.bin",
    );
    expect(controller.stop()).toMatchObject({
      path: "data://imu/session_a.bin",
      sampleCount: 2,
      observedHzX100: 2_500,
      hasGyroscope: false,
    });
    expect(controller.stop()).toBeNull();
    expect(file.finalize).toHaveBeenCalledOnce();
    expect(collector.stop).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("rotates files without creating a second collector", () => {
    const { collector, controller, emit, file } = setup();
    controller.start();
    emit(sample);

    expect(controller.rotate("data://imu/session_b.bin")).toMatchObject({
      path: "data://imu/session_a.bin",
      sampleCount: 1,
    });
    expect(file.reset).toHaveBeenLastCalledWith(
      expect.objectContaining({ sampleCount: 0 }),
      "data://imu/session_b.bin",
    );
    expect(collector.start).toHaveBeenCalledOnce();
  });

  it("releases the display lease when session setup fails", () => {
    const resetError = new Error("disk full");
    const { controller, lease, onError } = setup({ resetError });

    expect(controller.start()).toBe(false);
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(resetError);
  });

  it("stops sensors and releases the display lease when a sample write fails", () => {
    const appendError = new Error("write failed");
    const { collector, controller, emit, lease, onError } = setup({ appendError });
    controller.start();
    emit(sample);
    emit({ ...sample, tMs: 2 });

    expect(controller.active).toBe(false);
    expect(collector.stop).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(appendError);
  });

  it("releases the display lease when sensor shutdown throws during explicit stop", () => {
    const stopError = new Error("sensor shutdown failed");
    const { controller, lease, onError } = setup({ stopError });
    controller.start();

    expect(controller.stop()).toBeNull();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(stopError);
  });

  it("releases the display lease when sensor shutdown throws after a write failure", () => {
    const appendError = new Error("write failed");
    const stopError = new Error("sensor shutdown failed");
    const { controller, emit, lease, onError } = setup({ appendError, stopError });
    controller.start();
    emit(sample);
    emit({ ...sample, tMs: 2 });

    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(stopError);
    expect(onError).toHaveBeenCalledWith(appendError);
  });
});
