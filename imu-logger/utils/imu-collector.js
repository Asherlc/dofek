import {
  Accelerometer,
  Gyroscope,
  checkSensor,
  FREQ_MODE_LOW,
  FREQ_MODE_NORMAL,
  FREQ_MODE_HIGH,
} from "@zos/sensor";

export const FREQ_MODES = [
  { value: FREQ_MODE_LOW, label: "LOW", rank: 0 },
  { value: FREQ_MODE_NORMAL, label: "NORMAL", rank: 1 },
  { value: FREQ_MODE_HIGH, label: "HIGH", rank: 2 },
];

export function resolveFreqMode(modeIndex) {
  const index = Number(modeIndex);
  if (index === 0) {
    return FREQ_MODE_LOW;
  }
  if (index === 2) {
    return FREQ_MODE_HIGH;
  }
  return FREQ_MODE_NORMAL;
}

export function highestAvailableFreqMode(sensorCtor) {
  if (!checkSensor(sensorCtor)) {
    return null;
  }

  const sensor = new sensorCtor();
  let selected = FREQ_MODE_LOW;

  for (let i = 0; i < FREQ_MODES.length; i += 1) {
    const mode = FREQ_MODES[i];
    try {
      sensor.setFreqMode(mode.value);
      const applied = sensor.getFreqMode();
      const appliedRank =
        FREQ_MODES.find((item) => item.value === applied)?.rank ?? mode.rank;
      const selectedRank =
        FREQ_MODES.find((item) => item.value === selected)?.rank ?? 0;

      if (appliedRank >= selectedRank) {
        selected = applied;
      }
    } catch (error) {
      // Documented behavior: unsupported modes fail silently on some builds.
    }
  }

  return selected;
}

export function createImuCollector(options) {
  const {
    enableGyro = false,
    requestedFreqModeIndex = 1,
    onSample,
    onStatus,
  } = options;

  const hasAccelerometer = checkSensor(Accelerometer);
  const hasGyroscope = enableGyro && checkSensor(Gyroscope);

  if (!hasAccelerometer) {
    return {
      available: false,
      reason: "Accelerometer unavailable on this device.",
      start() {},
      stop() {},
    };
  }

  const accelerometer = new Accelerometer();
  const gyroscope = hasGyroscope ? new Gyroscope() : null;

  const requestedMode = resolveFreqMode(requestedFreqModeIndex);
  const accelMode = pickBestMode(accelerometer, requestedMode);
  const gyroMode = gyroscope
    ? pickBestMode(gyroscope, requestedMode)
    : null;

  let latestGyro = { x: 0, y: 0, z: 0 };
  let sessionStartMs = 0;
  let sampleCount = 0;
  let windowStartMs = 0;
  let windowCount = 0;
  let observedHzX100 = 0;
  let running = false;

  const handleGyroChange = (value) => {
    if (value && typeof value.x === "number") {
      latestGyro = value;
    } else {
      latestGyro = gyroscope.getCurrent();
    }
  };

  function pickBestMode(sensor, desiredMode) {
    const desiredRank =
      FREQ_MODES.find((item) => item.value === desiredMode)?.rank ?? 1;
    let selected = FREQ_MODE_LOW;

    for (let i = 0; i < FREQ_MODES.length; i += 1) {
      const mode = FREQ_MODES[i];
      if (mode.rank > desiredRank) {
        continue;
      }

      try {
        sensor.setFreqMode(mode.value);
        const applied = sensor.getFreqMode();
        const appliedRank =
          FREQ_MODES.find((item) => item.value === applied)?.rank ?? mode.rank;
        const selectedRank =
          FREQ_MODES.find((item) => item.value === selected)?.rank ?? 0;

        if (appliedRank >= selectedRank) {
          selected = applied;
        }
      } catch (error) {
        // Keep trying lower modes.
      }
    }

    return selected;
  }

  function handleAccelChange(value) {
    if (!running) {
      return;
    }

    const now = Date.now();
    if (!sessionStartMs) {
      sessionStartMs = now;
      windowStartMs = now;
    }

    const reading =
      value && typeof value.x === "number" ? value : accelerometer.getCurrent();

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
  }

  return {
    available: true,
    hasGyroscope,
    accelMode,
    gyroMode,
    getStats() {
      return {
        sampleCount,
        observedHzX100,
        sessionStartMs,
      };
    },
    start() {
      if (running) {
        return;
      }

      sessionStartMs = 0;
      sampleCount = 0;
      windowStartMs = 0;
      windowCount = 0;
      observedHzX100 = 0;
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
      if (!running) {
        return;
      }

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
