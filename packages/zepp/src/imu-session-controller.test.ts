import { describe, expect, it, vi } from "vitest";
import type { DisplayLease } from "./display-lease.ts";
import { createImuSessionController } from "./imu-session-controller.ts";
import type { CollectorOptions, ImuCollector, ImuSample } from "./types.ts";

function setup(
  options: {
    appendError?: Error;
    resetError?: Error;
    stopError?: Error;
    startError?: Error;
    releaseError?: Error;
    hasGyro?: boolean;
    available?: boolean;
    unavailableReason?: string;
    withChunkCallback?: boolean;
    withProgressCallback?: boolean;
    now?: () => number;
    collectorSessionStartMs?: number;
  } = {},
) {
  let collectorOptions: CollectorOptions | undefined;
  const start = vi.fn(() => {
    if (options.startError) throw options.startError;
  });
  const stop = vi.fn(() => {
    if (options.stopError) throw options.stopError;
  });
  const collector: ImuCollector =
    options.available === false
      ? {
          available: false,
          reason: options.unavailableReason ?? "accelerometer unavailable",
          start,
          stop,
        }
      : {
          available: true,
          hasGyroscope: options.hasGyro ?? true,
          accelMode: 1,
          gyroMode: options.hasGyro === false ? null : 1,
          getStats: () => ({
            sampleCount: 0,
            observedHzX100: 0,
            sessionStartMs: options.collectorSessionStartMs ?? 0,
          }),
          start,
          stop,
        };
  const lease: DisplayLease = {
    acquired: false,
    acquire: vi.fn(),
    release: vi.fn(() => {
      if (options.releaseError) throw options.releaseError;
    }),
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
  const onChunk = vi.fn();
  const onProgress = vi.fn();
  const controller = createImuSessionController({
    path: "data://imu/session_a.bin",
    requestedFreqModeIndex: 1,
    flushThreshold: 2,
    now: options.now ?? (() => 1_720_000_000_000),
    displayLease: lease,
    createCollector: (value) => {
      collectorOptions = value;
      return collector;
    },
    file,
    onChunk: options.withChunkCallback === false ? undefined : onChunk,
    onProgress: options.withProgressCallback === false ? undefined : onProgress,
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
  return { collector, controller, emit, file, lease, onChunk, onError, onProgress, status };
}

const sample: ImuSample = { tMs: 1, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 };

describe("createImuSessionController", () => {
  it("starts an automatic gyro-capable segment with a display lease and canonical header", () => {
    const { collector, controller, file, lease } = setup();

    expect(controller.start()).toBe(true);
    expect(controller).toMatchObject({
      active: true,
      available: true,
      reason: null,
      hasGyroscope: true,
      accelFreqMode: 1,
      gyroFreqMode: 1,
    });
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
    expect(file.append).toHaveBeenCalledTimes(1);
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

  it("rebases collector-relative timestamps when rotating to a new segment", () => {
    const times = [1_720_000_000_000, 1_720_000_001_000];
    const { controller, emit, file } = setup({
      now: () => times.shift() ?? 1_720_000_001_000,
      collectorSessionStartMs: 1_720_000_000_000,
    });
    controller.start();
    emit({ ...sample, tMs: 960 });
    controller.rotate("data://imu/session_b.bin");
    emit({ ...sample, tMs: 1_040 });
    controller.stop();

    expect(file.append).toHaveBeenCalledWith(
      [{ ...sample, tMs: 40 }],
      true,
      "data://imu/session_b.bin",
    );
  });

  it("publishes the same persisted chunk for redundant phone delivery", () => {
    const { controller, emit, onChunk } = setup();
    controller.start();
    emit(sample);
    emit({ ...sample, tMs: 2 });

    expect(onChunk).toHaveBeenCalledWith({
      sessionStartMs: 1_720_000_000_000,
      hasGyroscope: true,
      samples: [sample, { ...sample, tMs: 2 }],
    });
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
    const { controller, emit, file, lease, onError } = setup({ stopError });
    controller.start();
    emit(sample);

    expect(controller.stop()).toMatchObject({
      path: "data://imu/session_a.bin",
      sampleCount: 1,
    });
    expect(file.finalize).toHaveBeenCalledOnce();
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

  it("reports unavailable sensors without acquiring resources", () => {
    const { collector, controller, emit, file, lease, onError, onProgress, status } = setup({
      available: false,
      unavailableReason: "accelerometer denied",
    });

    expect(controller).toMatchObject({
      active: false,
      available: false,
      reason: "accelerometer denied",
      hasGyroscope: false,
      accelFreqMode: 0,
      gyroFreqMode: 0,
      sampleCount: 0,
      observedHzX100: 0,
    });
    expect(controller.start()).toBe(false);
    expect(controller.rotate("data://imu/session_b.bin")).toBeNull();
    expect(controller.stop()).toBeNull();
    emit(sample);
    status(1, 2_500);
    expect(collector.start).not.toHaveBeenCalled();
    expect(collector.stop).not.toHaveBeenCalled();
    expect(lease.acquire).not.toHaveBeenCalled();
    expect(file.append).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores samples and status outside an active session", () => {
    const { controller, emit, file, onProgress, status } = setup();
    emit(sample);
    status(1, 1_000);
    expect(controller.start()).toBe(true);
    emit(sample);
    status(1, 2_500);

    expect(controller.sampleCount).toBe(1);
    expect(controller.observedHzX100).toBe(2_500);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ sampleCount: 1, observedHzX100: 2_500 });
    expect(controller.stop()).not.toBeNull();
    emit({ ...sample, tMs: 2 });
    status(2, 5_000);
    expect(controller.sampleCount).toBe(1);
    expect(controller.observedHzX100).toBe(2_500);
    expect(file.append).toHaveBeenCalledExactlyOnceWith([sample], true, "data://imu/session_a.bin");
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("starts an active controller idempotently", () => {
    const { collector, controller, file, lease } = setup();

    expect(controller.start()).toBe(true);
    expect(controller.active).toBe(true);
    expect(controller.start()).toBe(true);
    expect(collector.start).toHaveBeenCalledTimes(1);
    expect(file.reset).toHaveBeenCalledTimes(1);
    expect(lease.acquire).toHaveBeenCalledTimes(1);
  });

  it("stops and reports both sensor and setup failures", () => {
    const startError = new Error("sensor start failed");
    const stopError = new Error("sensor cleanup failed");
    const { collector, controller, lease, onError } = setup({ startError, stopError });

    expect(controller.start()).toBe(false);
    expect(controller.active).toBe(false);
    expect(collector.stop).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenNthCalledWith(1, stopError);
    expect(onError).toHaveBeenNthCalledWith(2, startError);
  });

  it("reports display-release failures after returning the completed segment", () => {
    const releaseError = new Error("display release failed");
    const { controller, lease, onError } = setup({ releaseError });
    controller.start();

    expect(controller.stop()).toMatchObject({ path: "data://imu/session_a.bin", sampleCount: 0 });
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(releaseError);
  });

  it("rotates an empty segment without appending an empty chunk", () => {
    const { controller, file } = setup();
    controller.start();

    expect(controller.rotate("data://imu/session_b.bin")).toMatchObject({
      path: "data://imu/session_a.bin",
      sampleCount: 0,
    });
    expect(file.append).not.toHaveBeenCalled();
    expect(file.finalize).toHaveBeenCalledExactlyOnceWith(0, 0, "data://imu/session_a.bin");
  });

  it("does not rotate a ready collector before its session starts", () => {
    const { collector, controller, file, lease } = setup();

    expect(controller.rotate("data://imu/session_b.bin")).toBeNull();
    expect(collector.stop).not.toHaveBeenCalled();
    expect(file.reset).not.toHaveBeenCalled();
    expect(file.finalize).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it("supports omitted optional progress and chunk observers", () => {
    const { controller, emit, onChunk, onError, onProgress, status } = setup({
      withChunkCallback: false,
      withProgressCallback: false,
    });
    controller.start();
    emit(sample);
    emit({ ...sample, tMs: 2 });
    status(2, 2_500);

    expect(controller.stop()).not.toBeNull();
    expect(onChunk).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps collector-relative timestamps when the collector has no start time", () => {
    const times = [1_720_000_000_000, 1_720_000_001_000];
    const { controller, emit, file } = setup({
      now: () => times.shift() ?? 1_720_000_001_000,
      collectorSessionStartMs: 0,
    });
    controller.start();
    controller.rotate("data://imu/session_b.bin");
    emit({ ...sample, tMs: 1_040 });
    controller.stop();

    expect(file.append).toHaveBeenCalledWith(
      [{ ...sample, tMs: 1_040 }],
      true,
      "data://imu/session_b.bin",
    );
  });

  it("returns the finalized segment and stops the session when the next file reset fails", () => {
    const resetError = new Error("next file reset failed");
    const { collector, controller, file, lease, onError } = setup();
    controller.start();
    file.reset.mockImplementationOnce(() => {
      throw resetError;
    });

    expect(controller.rotate("data://imu/session_b.bin")).toMatchObject({
      path: "data://imu/session_a.bin",
      sampleCount: 0,
    });
    expect(controller.active).toBe(false);
    expect(collector.stop).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(resetError);
  });

  it("returns null and reports finalization failures during stop", () => {
    const finalizeError = new Error("finalize failed");
    const { controller, file, lease, onError } = setup();
    controller.start();
    file.finalize.mockImplementationOnce(() => {
      throw finalizeError;
    });

    expect(controller.stop()).toBeNull();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(finalizeError);
  });
});
