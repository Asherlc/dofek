import type { CollectorOptions, CollectorStats, FreqModeEntry, ImuCollector } from "./types.ts";

export interface ZosSensor {
  setFreqMode(mode: number): void;
  getFreqMode(): number;
  onChange(cb: (value: { x: number; y: number; z: number }) => void): void;
  offChange(cb: (value: { x: number; y: number; z: number }) => void): void;
  start(): void;
  stop(): void;
  getCurrent(): { x: number; y: number; z: number };
}

export interface SensorCtor {
  new (...args: never[]): ZosSensor;
}

export const FREQ_MODES: FreqModeEntry[] = [
  { value: 0, label: "LOW", rank: 0 },
  { value: 1, label: "NORMAL", rank: 1 },
  { value: 2, label: "HIGH", rank: 2 },
];

export function resolveFreqMode(modeIndex: number): number {
  const index = Number(modeIndex);
  if (index === 0) return 0;
  if (index === 2) return 2;
  return 1;
}

export function rankOfMode(modeValue: number, fallback = 0): number {
  const entry = FREQ_MODES.find((item) => item.value === modeValue);
  return entry ? entry.rank : fallback;
}

export function highestAvailableFreqMode(
  sensorCtor: SensorCtor,
  checkSensor: (ctor: SensorCtor) => boolean,
): number | null {
  if (!checkSensor(sensorCtor)) {
    return null;
  }

  const sensor = new sensorCtor();
  let selected = 0;

  for (let i = 0; i < FREQ_MODES.length; i += 1) {
    const entry = FREQ_MODES[i];
    if (!entry) continue;
    try {
      sensor.setFreqMode(entry.value);
      const applied = sensor.getFreqMode();
      const appliedRank = rankOfMode(applied, entry.rank);
      const selectedRank = rankOfMode(selected);

      if (appliedRank >= selectedRank) {
        selected = applied;
      }
    } catch {
      // keep trying lower modes
    }
  }

  return selected;
}

function pickBestMode(sensor: ZosSensor, desiredMode: number): number {
  const desiredRank = rankOfMode(desiredMode, 1);
  let selected = 0;

  for (let i = 0; i < FREQ_MODES.length; i += 1) {
    const mode = FREQ_MODES[i];
    if (!mode) continue;
    if (mode.rank > desiredRank) {
      continue;
    }

    try {
      sensor.setFreqMode(mode.value);
      const applied = sensor.getFreqMode();
      const appliedRank = rankOfMode(applied, mode.rank);
      const selectedRank = rankOfMode(selected);

      if (appliedRank >= selectedRank && appliedRank <= desiredRank) {
        selected = applied;
      }
    } catch {
      // keep trying lower modes
    }
  }

  return selected;
}

export function createImuCollector(
  options: CollectorOptions,
  deps: {
    Accelerometer: SensorCtor;
    Gyroscope: SensorCtor;
    checkSensor: (ctor: SensorCtor) => boolean;
  },
): ImuCollector {
  const { enableGyro = false, requestedFreqModeIndex = 1, onSample, onStatus } = options;

  const { Accelerometer, Gyroscope, checkSensor } = deps;

  const hasAccelerometer = checkSensor(Accelerometer);
  const hasGyroscope = enableGyro && checkSensor(Gyroscope);

  if (!hasAccelerometer) {
    return {
      available: false as const,
      reason: "Accelerometer unavailable on this device.",
      start() {},
      stop() {},
    };
  }

  const accelerometer = new Accelerometer();
  const gyroscope = hasGyroscope ? new Gyroscope() : null;

  const requestedMode = resolveFreqMode(requestedFreqModeIndex);
  const accelMode = pickBestMode(accelerometer, requestedMode);
  const gyroMode = gyroscope ? pickBestMode(gyroscope, requestedMode) : null;

  let latestGyro = { x: 0, y: 0, z: 0 };
  let sessionStartMs = 0;
  let sampleCount = 0;
  let windowStartMs = 0;
  let windowCount = 0;
  let observedHzX100 = 0;
  let running = false;

  const handleGyroChange = (value: { x: number; y: number; z: number }) => {
    if (value && typeof value.x === "number") {
      latestGyro = value;
    } else {
      latestGyro = gyroscope?.getCurrent() ?? { x: 0, y: 0, z: 0 };
    }
  };

  const handleAccelChange = (value: { x: number; y: number; z: number }) => {
    if (!running) return;

    const now = Date.now();
    if (!sessionStartMs) {
      sessionStartMs = now;
      windowStartMs = now;
    }

    const reading = value && typeof value.x === "number" ? value : accelerometer.getCurrent();

    sampleCount += 1;
    windowCount += 1;

    if (now - windowStartMs >= 1000) {
      const hz = windowCount / ((now - windowStartMs) / 1000);
      observedHzX100 = Math.round(hz * 100);
      windowStartMs = now;
      windowCount = 0;

      if (onStatus) {
        onStatus({
          sampleCount,
          observedHzX100,
        });
      }
    }

    onSample({
      tMs: now - sessionStartMs,
      ax: reading.x,
      ay: reading.y,
      az: reading.z,
      gx: latestGyro.x,
      gy: latestGyro.y,
      gz: latestGyro.z,
    });
  };

  return {
    available: true as const,
    hasGyroscope,
    accelMode,
    gyroMode,
    getStats(): CollectorStats {
      return { sampleCount, observedHzX100, sessionStartMs };
    },
    start() {
      if (running) return;

      sessionStartMs = 0;
      sampleCount = 0;
      windowStartMs = 0;
      windowCount = 0;
      observedHzX100 = 0;
      latestGyro = { x: 0, y: 0, z: 0 };
      running = true;

      accelerometer.setFreqMode(accelMode);
      accelerometer.onChange(handleAccelChange);

      if (gyroscope && gyroMode !== null) {
        gyroscope.setFreqMode(gyroMode);
        gyroscope.onChange(handleGyroChange);
        gyroscope.start();
      }

      accelerometer.start();
    },
    stop() {
      if (!running) return;

      running = false;
      accelerometer.offChange(handleAccelChange);
      accelerometer.stop();

      if (gyroscope) {
        gyroscope.offChange(handleGyroChange);
        gyroscope.stop();
      }
    },
  };
}
