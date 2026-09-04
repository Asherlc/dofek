import { describe, expect, it, vi } from "vitest";
import type { SensorCtor } from "./imu-collector.ts";
import {
  createImuCollector,
  highestAvailableFreqMode,
  rankOfMode,
  resolveFreqMode,
} from "./imu-collector.ts";

function makeMockSensor(
  overrides?: Partial<{
    supported: number[];
    currentValue: { x: number; y: number; z: number };
  }>,
) {
  let fakeFreqMode = 1;
  const supported = overrides?.supported ?? [0, 1, 2];

  return {
    setFreqMode: vi.fn((m: number) => {
      if (supported.includes(m)) fakeFreqMode = m;
    }),
    getFreqMode: vi.fn(() => fakeFreqMode),
    onChange: vi.fn(),
    offChange: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getCurrent: vi.fn(() => overrides?.currentValue ?? { x: 0, y: 0, z: 0 }),
  };
}

/** Returns the first argument the mock was called with, asserting it was called. */
function firstCallArg(mockFn: ReturnType<typeof vi.fn>) {
  const [firstCall] = mockFn.mock.calls;
  if (!firstCall) throw new Error("expected mock to have been called at least once");
  return firstCall[0];
}

function ctorFor(sensor: ReturnType<typeof makeMockSensor>): SensorCtor {
  return class {
    setFreqMode = sensor.setFreqMode;
    getFreqMode = sensor.getFreqMode;
    onChange = sensor.onChange;
    offChange = sensor.offChange;
    start = sensor.start;
    stop = sensor.stop;
    getCurrent = sensor.getCurrent;
  };
}

describe("resolveFreqMode", () => {
  it("returns LOW for index 0", () => {
    expect(resolveFreqMode(0)).toBe(0);
  });

  it("returns NORMAL for index 1", () => {
    expect(resolveFreqMode(1)).toBe(1);
  });

  it("returns HIGH for index 2", () => {
    expect(resolveFreqMode(2)).toBe(2);
  });

  it("defaults to NORMAL for unknown index", () => {
    expect(resolveFreqMode(99)).toBe(1);
  });
});

describe("rankOfMode", () => {
  it("returns rank for known mode values", () => {
    expect(rankOfMode(0)).toBe(0);
    expect(rankOfMode(1)).toBe(1);
    expect(rankOfMode(2)).toBe(2);
  });

  it("returns fallback for unknown mode value", () => {
    expect(rankOfMode(99)).toBe(0);
    expect(rankOfMode(99, 5)).toBe(5);
  });

  it("returns 0 as default fallback", () => {
    expect(rankOfMode(-1)).toBe(0);
  });
});

describe("highestAvailableFreqMode", () => {
  it("returns null when sensor is unavailable", () => {
    const result = highestAvailableFreqMode(ctorFor(makeMockSensor()), () => false);
    expect(result).toBeNull();
  });

  it("returns the best supported mode", () => {
    const sen = makeMockSensor({ supported: [0] });
    const result = highestAvailableFreqMode(ctorFor(sen), () => true);
    expect(result).toBe(0);
    expect(sen.setFreqMode).toHaveBeenCalledWith(0);
  });

  it("prefers HIGH when supported", () => {
    const sen = makeMockSensor({ supported: [0, 1, 2] });
    const result = highestAvailableFreqMode(ctorFor(sen), () => true);
    expect(result).toBe(2);
  });

  it("selects NORMAL when HIGH unsupported", () => {
    const sen = makeMockSensor({ supported: [0, 1] });
    const result = highestAvailableFreqMode(ctorFor(sen), () => true);
    expect(result).toBe(1);
  });

  it("survives setFreqMode throwing for all modes", () => {
    const sen = makeMockSensor();
    sen.setFreqMode.mockImplementation(() => {
      throw new Error("not supported");
    });
    const result = highestAvailableFreqMode(ctorFor(sen), () => true);
    expect(result).toBe(0);
  });

  it("returns LOW (0) when only LOW is supported", () => {
    const sen = makeMockSensor({ supported: [0] });
    const result = highestAvailableFreqMode(ctorFor(sen), () => true);
    expect(result).toBe(0);
    expect(sen.getFreqMode).toHaveBeenCalled();
  });
});

describe("createImuCollector", () => {
  it("returns unavailable when accelerometer is missing", () => {
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(makeMockSensor()),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => false,
      },
    );

    expect(collector.available).toBe(false);
    if (!collector.available) {
      expect(collector.reason).toContain("Accelerometer");
    }
  });

  it("automatically detects gyroscope when the sensor exists", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    expect(collector.available).toBe(true);
    if (collector.available) {
      expect(collector.hasGyroscope).toBe(true);
    }
  });

  it("falls back to accelerometer-only when gyroscope is unavailable", () => {
    const accel = makeMockSensor();
    const gyroCtor = ctorFor(makeMockSensor());
    const accelCtor = ctorFor(accel);
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: accelCtor,
        Gyroscope: gyroCtor,
        checkSensor: (ctor) => ctor === accelCtor,
      },
    );

    expect(collector.available).toBe(true);
    if (collector.available) {
      expect(collector.hasGyroscope).toBe(false);
      expect(collector.gyroMode).toBeNull();
    }
  });

  it("start() configures and turns on the accelerometer", () => {
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    expect(accel.setFreqMode).toHaveBeenCalled();
    expect(accel.start).toHaveBeenCalled();
  });

  it("stop() turns off sensor and gyro", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    collector.stop();
    expect(accel.offChange).toHaveBeenCalled();
    expect(accel.stop).toHaveBeenCalled();
    expect(gyro.offChange).toHaveBeenCalled();
    expect(gyro.stop).toHaveBeenCalled();
  });

  it("start() is idempotent (safe to call twice)", () => {
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    collector.start();
    expect(accel.start).toHaveBeenCalledTimes(1);
  });

  it("stop() is idempotent when not running", () => {
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.stop();
    expect(accel.stop).not.toHaveBeenCalled();
  });

  it("provides stats after start()", () => {
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const stats = collector.getStats();
    expect(stats).toHaveProperty("sampleCount", 0);
    expect(stats).toHaveProperty("observedHzX100", 0);
    expect(stats).toHaveProperty("sessionStartMs");
  });

  it("calls onSample with expected data when accelerometer fires", () => {
    const accel = makeMockSensor();
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    accelCb({ x: 1, y: 2, z: 3 });

    expect(onSample).toHaveBeenCalledTimes(1);
    const sample = firstCallArg(onSample);
    expect(sample).toMatchObject({ ax: 1, ay: 2, az: 3, gx: 0, gy: 0, gz: 0 });
    expect(sample.tMs).toBeGreaterThanOrEqual(0);
    expect(sample.tMs).toBeLessThan(100);

    const stats = collector.getStats();
    expect(stats.sampleCount).toBe(1);
  });

  it("limits accel mode to at most the requested freq mode rank", () => {
    const accel = makeMockSensor({ supported: [0, 1, 2] });
    const gyro = makeMockSensor({ supported: [0] });
    const collector = createImuCollector(
      { requestedFreqModeIndex: 1, onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    expect(collector.accelMode).toBe(1);
    expect(collector.gyroMode).toBe(0);
  });

  it("selects highest supported mode when requested mode is available", () => {
    const accel = makeMockSensor({ supported: [0, 1] });
    const gyro = makeMockSensor({ supported: [0] });
    const collector = createImuCollector(
      { requestedFreqModeIndex: 2, onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    expect(collector.accelMode).toBe(1);
    expect(collector.gyroMode).toBe(0);
  });

  it("includes gyroscope data in samples when gyro fires", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor({ currentValue: { x: 10, y: 20, z: 30 } });
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const gyroCb = firstCallArg(gyro.onChange);
    gyroCb({ x: 4, y: 5, z: 6 });

    const accelCb = firstCallArg(accel.onChange);
    accelCb({ x: 1, y: 2, z: 3 });

    const sample = firstCallArg(onSample);
    expect(sample).toMatchObject({ gx: 4, gy: 5, gz: 6, ax: 1, ay: 2, az: 3 });
  });

  it("uses getCurrent fallback when gyro change value is missing x", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor({ currentValue: { x: 99, y: 88, z: 77 } });
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const gyroCb = firstCallArg(gyro.onChange);
    gyroCb({ y: 99, z: 88 });

    const accelCb = firstCallArg(accel.onChange);
    accelCb({ x: 1, y: 2, z: 3 });

    const sample = firstCallArg(onSample);
    expect(sample).toMatchObject({ gx: 99, gy: 88, gz: 77 });
  });

  it("calls onStatus after collecting samples for over a second", () => {
    vi.useFakeTimers();
    const accel = makeMockSensor();
    const onStatus = vi.fn();
    const collector = createImuCollector(
      { onSample: vi.fn(), onStatus },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    accelCb({ x: 0, y: 0, z: 0 });
    expect(onStatus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    accelCb({ x: 0, y: 0, z: 0 });

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(firstCallArg(onStatus)).toHaveProperty("sampleCount", 2);
    expect(firstCallArg(onStatus)).toHaveProperty("observedHzX100");

    vi.useRealTimers();
  });

  it("reports observedHz in getStats after rate window elapses", () => {
    vi.useFakeTimers();
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    accelCb({ x: 0, y: 0, z: 0 });
    let stats = collector.getStats();
    expect(stats.observedHzX100).toBe(0);

    vi.advanceTimersByTime(1000);
    accelCb({ x: 0, y: 0, z: 0 });

    stats = collector.getStats();
    expect(stats.observedHzX100).toBe(200);

    vi.useRealTimers();
  });

  it("computes observed Hz correctly for non-1s windows", () => {
    vi.useFakeTimers();
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    accelCb({ x: 0, y: 0, z: 0 });
    vi.advanceTimersByTime(2000);
    accelCb({ x: 0, y: 0, z: 0 });

    const stats = collector.getStats();
    expect(stats.observedHzX100).toBe(100);

    vi.useRealTimers();
  });

  it("does not produce samples when stopped", () => {
    const accel = makeMockSensor();
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    collector.stop();
    accelCb({ x: 1, y: 2, z: 3 });

    expect(onSample).not.toHaveBeenCalled();
  });

  it("start() resets state for a new session", () => {
    vi.useFakeTimers();
    const accel = makeMockSensor();
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    accelCb({ x: 1, y: 2, z: 3 });
    let stats = collector.getStats();
    expect(stats.sampleCount).toBe(1);

    collector.stop();
    vi.advanceTimersByTime(5000);
    collector.start();

    accelCb({ x: 4, y: 5, z: 6 });
    stats = collector.getStats();
    expect(stats.sampleCount).toBe(1);

    vi.useRealTimers();
  });

  it("uses accelerometer.getCurrent when onChange value is invalid", () => {
    const accel = makeMockSensor({ currentValue: { x: 7, y: 8, z: 9 } });
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const accelCb = firstCallArg(accel.onChange);

    accelCb({ y: 8, z: 9 });

    const sample = firstCallArg(onSample);
    expect(sample).toMatchObject({ ax: 7, ay: 8, az: 9 });
  });

  it("does not emit samples before start() is called", () => {
    const accel = makeMockSensor();
    const onSample = vi.fn();
    createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
      },
    );

    const accelCb = accel.onChange.mock.calls[0]?.[0];
    expect(accelCb).toBeUndefined();
    expect(onSample).not.toHaveBeenCalled();
  });

  it("uses gyro getCurrent values in fallback (not zero literal)", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor({ currentValue: { x: 11, y: 22, z: 33 } });
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const gyroCb = firstCallArg(gyro.onChange);
    gyroCb(null);

    const accelCb = firstCallArg(accel.onChange);
    accelCb({ x: 1, y: 2, z: 3 });

    const sample = firstCallArg(onSample);
    expect(sample.gx).toBe(11);
    expect(sample.gy).toBe(22);
    expect(sample.gz).toBe(33);
  });

  it("start/stop/start resets gyro to zero between sessions", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor();
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const gyroCb = firstCallArg(gyro.onChange);
    gyroCb({ x: 50, y: 60, z: 70 });

    collector.stop();
    collector.start();

    const accelCb = firstCallArg(accel.onChange);
    accelCb({ x: 1, y: 2, z: 3 });

    const sample = firstCallArg(onSample);
    expect(sample.gx).toBe(0);
    expect(sample.gy).toBe(0);
    expect(sample.gz).toBe(0);
  });

  it("uses gyro getCurrent reading when the change value is invalid", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor({ currentValue: { x: 0, y: 0, z: 0 } });
    const onSample = vi.fn();
    const collector = createImuCollector(
      { onSample },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(gyro),
        checkSensor: () => true,
      },
    );

    if (!collector.available) return;

    collector.start();
    const gyroCb = firstCallArg(gyro.onChange);
    gyroCb({});

    const accelCb = firstCallArg(accel.onChange);
    accelCb({ x: 1, y: 2, z: 3 });

    const sample = firstCallArg(onSample);
    expect(sample).toMatchObject({ gx: 0, gy: 0, gz: 0 });
  });
});
