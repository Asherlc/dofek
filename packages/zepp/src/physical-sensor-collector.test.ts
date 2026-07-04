import { describe, expect, it, vi } from "vitest";
import type {
  PhysicalSensorCollectorCallbacks,
  PhysicalSensorDeps,
} from "./physical-sensor-collector.ts";
import { createPhysicalSensorCollector } from "./physical-sensor-collector.ts";
import type { LocationSample, PhysicalScalarSample } from "./types.ts";

type SensorCallback = () => void;

function requireCallback(callback: SensorCallback | undefined): SensorCallback {
  if (!callback) {
    throw new Error("expected sensor callback to be registered");
  }
  return callback;
}

function makeCallbacks(): {
  callbacks: PhysicalSensorCollectorCallbacks;
  scalarSamples: PhysicalScalarSample[];
  locationSamples: LocationSample[];
} {
  const scalarSamples: PhysicalScalarSample[] = [];
  const locationSamples: LocationSample[] = [];

  return {
    callbacks: {
      onScalarSample: (sample) => scalarSamples.push(sample),
      onLocationSample: (sample) => locationSamples.push(sample),
    },
    scalarSamples,
    locationSamples,
  };
}

describe("createPhysicalSensorCollector", () => {
  it("records raw heart rate and barometer samples", () => {
    const { callbacks, scalarSamples } = makeCallbacks();
    let heartRateCallback: SensorCallback | undefined;
    let barometerCallback: SensorCallback | undefined;

    class FakeHeartRate {
      getCurrent() {
        return 72;
      }
      onCurrentChange(callback: SensorCallback) {
        heartRateCallback = callback;
      }
      offCurrentChange(_callback: SensorCallback) {}
    }

    class FakeBarometer {
      getAirPressure() {
        return 1012.3;
      }
      getAltitude() {
        return 42;
      }
      onChange(callback: SensorCallback) {
        barometerCallback = callback;
      }
      offChange(_callback: SensorCallback) {}
    }

    const collector = createPhysicalSensorCollector(callbacks, {
      now: () => 1000,
      HeartRate: FakeHeartRate,
      Barometer: FakeBarometer,
    });

    collector.start(1000);
    requireCallback(heartRateCallback)();
    requireCallback(barometerCallback)();

    expect(scalarSamples).toContainEqual({ tMs: 0, channel: "heartRate", value: 72 });
    expect(scalarSamples).toContainEqual({
      tMs: 0,
      channel: "barometricPressure",
      value: 1012.3,
    });
    expect(scalarSamples).toContainEqual({ tMs: 0, channel: "altitude", value: 42 });
  });

  it("ignores computed summary sensors", () => {
    const { callbacks, scalarSamples, locationSamples } = makeCallbacks();

    class FakeStep {
      getCurrent() {
        return 12_345;
      }
    }

    const deps = {
      now: () => 1000,
      Step: FakeStep,
    };

    const collector = createPhysicalSensorCollector(callbacks, deps);

    collector.start(1000);

    expect(scalarSamples).toEqual([]);
    expect(locationSamples).toEqual([]);
  });

  it("ignores failed SpO2 readings without stopping heart rate", () => {
    const { callbacks, scalarSamples } = makeCallbacks();
    let bloodOxygenCallback: SensorCallback | undefined;
    let heartRateCallback: SensorCallback | undefined;

    class FakeBloodOxygen {
      start() {}
      stop() {}
      getCurrent() {
        return { status: 3 };
      }
      onChange(callback: SensorCallback) {
        bloodOxygenCallback = callback;
      }
      offChange(_callback: SensorCallback) {}
    }

    class FakeHeartRate {
      getCurrent() {
        return 72;
      }
      onCurrentChange(callback: SensorCallback) {
        heartRateCallback = callback;
      }
      offCurrentChange(_callback: SensorCallback) {}
    }

    const collector = createPhysicalSensorCollector(callbacks, {
      now: () => 1000,
      BloodOxygen: FakeBloodOxygen,
      HeartRate: FakeHeartRate,
    });

    collector.start(1000);

    expect(() => requireCallback(bloodOxygenCallback)()).not.toThrow();
    requireCallback(heartRateCallback)();

    expect(scalarSamples).toEqual([{ tMs: 0, channel: "heartRate", value: 72 }]);
  });

  it("uses passive location without starting geolocation", () => {
    const { callbacks, locationSamples } = makeCallbacks();
    let geolocationCallback: SensorCallback | undefined;
    const start = vi.fn();
    const onChange = vi.fn((callback: SensorCallback) => {
      geolocationCallback = callback;
    });

    class FakeGeolocation {
      start = start;
      getStatus() {
        return "A";
      }
      getLatitude(option?: { format?: "DD" }) {
        expect(option).toEqual({ format: "DD" });
        return 37.1;
      }
      getLongitude(option?: { format?: "DD" }) {
        expect(option).toEqual({ format: "DD" });
        return -122.1;
      }
      onChange = onChange;
      offChange(_callback: SensorCallback) {}
    }

    const collector = createPhysicalSensorCollector(callbacks, {
      now: () => 1000,
      Geolocation: FakeGeolocation,
    });

    collector.start(1000);
    requireCallback(geolocationCallback)();

    expect(start).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(locationSamples).toEqual([{ tMs: 0, latitude: 37.1, longitude: -122.1 }]);
  });

  it("does not emit a location for invalid geolocation status", () => {
    const { callbacks, locationSamples } = makeCallbacks();
    let geolocationCallback: SensorCallback | undefined;

    class FakeGeolocation {
      getStatus() {
        return "V";
      }
      getLatitude(_option?: { format?: "DD" }) {
        return 37.1;
      }
      getLongitude(_option?: { format?: "DD" }) {
        return -122.1;
      }
      onChange(callback: SensorCallback) {
        geolocationCallback = callback;
      }
      offChange(_callback: SensorCallback) {}
    }

    const collector = createPhysicalSensorCollector(callbacks, {
      now: () => 1000,
      Geolocation: FakeGeolocation,
    });

    collector.start(1000);
    requireCallback(geolocationCallback)();

    expect(locationSamples).toEqual([]);
  });

  it("unsubscribes and stops active sensors without stopping geolocation", () => {
    const { callbacks } = makeCallbacks();
    const heartRateOffCurrentChange = vi.fn();
    const bloodOxygenStop = vi.fn();
    const bloodOxygenOffChange = vi.fn();
    const barometerOffChange = vi.fn();
    const compassStop = vi.fn();
    const compassOffChange = vi.fn();
    const geolocationOffChange = vi.fn();
    const geolocationStop = vi.fn();

    class FakeHeartRate {
      getCurrent() {
        return 72;
      }
      onCurrentChange(_callback: SensorCallback) {}
      offCurrentChange = heartRateOffCurrentChange;
    }

    class FakeBloodOxygen {
      start() {}
      stop = bloodOxygenStop;
      getCurrent() {
        return { value: 97, status: 0 };
      }
      onChange(_callback: SensorCallback) {}
      offChange = bloodOxygenOffChange;
    }

    class FakeBarometer {
      getAirPressure() {
        return 1012.3;
      }
      getAltitude() {
        return 42;
      }
      onChange(_callback: SensorCallback) {}
      offChange = barometerOffChange;
    }

    class FakeCompass {
      start() {}
      stop = compassStop;
      getStatus() {
        return true;
      }
      getDirectionAngle() {
        return 270;
      }
      onChange(_callback: SensorCallback) {}
      offChange = compassOffChange;
    }

    class FakeGeolocation {
      stop = geolocationStop;
      getStatus() {
        return "A";
      }
      getLatitude(_option?: { format?: "DD" }) {
        return 37.1;
      }
      getLongitude(_option?: { format?: "DD" }) {
        return -122.1;
      }
      onChange(_callback: SensorCallback) {}
      offChange = geolocationOffChange;
    }

    const deps: PhysicalSensorDeps = {
      now: () => 1000,
      HeartRate: FakeHeartRate,
      BloodOxygen: FakeBloodOxygen,
      Barometer: FakeBarometer,
      Compass: FakeCompass,
      Geolocation: FakeGeolocation,
    };
    const collector = createPhysicalSensorCollector(callbacks, deps);

    collector.start(1000);
    collector.stop();

    expect(heartRateOffCurrentChange).toHaveBeenCalledTimes(1);
    expect(bloodOxygenOffChange).toHaveBeenCalledTimes(1);
    expect(bloodOxygenStop).toHaveBeenCalledTimes(1);
    expect(barometerOffChange).toHaveBeenCalledTimes(1);
    expect(compassOffChange).toHaveBeenCalledTimes(1);
    expect(compassStop).toHaveBeenCalledTimes(1);
    expect(geolocationOffChange).toHaveBeenCalledTimes(1);
    expect(geolocationStop).not.toHaveBeenCalled();
  });
});
