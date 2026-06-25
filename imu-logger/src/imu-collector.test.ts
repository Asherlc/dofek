import { describe, expect, it, vi } from "vitest";
import type { SensorCtor } from "./imu-collector.ts";
import { createImuCollector, highestAvailableFreqMode, resolveFreqMode } from "./imu-collector.ts";

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

  it("detects gyroscope when enableGyro is true and sensor exists", () => {
    const accel = makeMockSensor();
    const gyro = makeMockSensor();
    const collector = createImuCollector(
      { enableGyro: true, onSample: vi.fn() },
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

  it("reports no gyroscope when enableGyro is false", () => {
    const accel = makeMockSensor();
    const collector = createImuCollector(
      { enableGyro: false, onSample: vi.fn() },
      {
        Accelerometer: ctorFor(accel),
        Gyroscope: ctorFor(makeMockSensor()),
        checkSensor: () => true,
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
      { enableGyro: true, onSample: vi.fn() },
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
});
