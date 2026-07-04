import type { LocationSample, PhysicalScalarSample } from "./types.ts";

export interface PhysicalSensorCollectorCallbacks {
  onScalarSample(sample: PhysicalScalarSample): void;
  onLocationSample(sample: LocationSample): void;
  onStatus?(status: { enabledChannels: string[]; disabledChannels: string[] }): void;
}

export interface PhysicalSensorDeps {
  now(): number;
  HeartRate?: new () => {
    getCurrent(): number;
    onCurrentChange(callback: () => void): void;
    offCurrentChange(callback: () => void): void;
  };
  BloodOxygen?: new () => {
    start(): void;
    stop(): void;
    getCurrent(): { value?: number; status?: number };
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
  Barometer?: new () => {
    getAirPressure(): number;
    getAltitude(): number;
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
  Compass?: new () => {
    start(): void;
    stop(): void;
    getStatus(): boolean;
    getDirectionAngle(): number | "INVALID";
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
  Geolocation?: new () => {
    getStatus(): string;
    getLatitude(option?: { format?: "DD" }): number;
    getLongitude(option?: { format?: "DD" }): number;
    onChange(callback: () => void): void;
    offChange(callback: () => void): void;
  };
}

interface PhysicalSensorCollector {
  start(sessionStartMs: number): void;
  stop(): void;
}

type StopHandler = () => void;

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeStop(handler: StopHandler): void {
  try {
    handler();
  } catch {
    // Stop is best-effort so one sensor cannot prevent others from shutting down.
  }
}

export function createPhysicalSensorCollector(
  callbacks: PhysicalSensorCollectorCallbacks,
  deps: PhysicalSensorDeps,
): PhysicalSensorCollector {
  let running = false;
  let sessionStartMs = 0;
  let stopHandlers: StopHandler[] = [];
  let activeGeneration = 0;

  function relativeTimeMs(): number {
    return deps.now() - sessionStartMs;
  }

  function emitScalar(sample: Omit<PhysicalScalarSample, "tMs">): void {
    if (!running) return;
    callbacks.onScalarSample({ tMs: relativeTimeMs(), ...sample });
  }

  function emitLocation(sample: Omit<LocationSample, "tMs">): void {
    if (!running) return;
    callbacks.onLocationSample({ tMs: relativeTimeMs(), ...sample });
  }

  function isCurrentGeneration(generation: number): boolean {
    return running && generation === activeGeneration;
  }

  function setupHeartRate(): boolean {
    if (!deps.HeartRate) return false;

    try {
      const heartRate = new deps.HeartRate();
      const generation = activeGeneration;
      const handleChange = () => {
        if (!isCurrentGeneration(generation)) return;

        try {
          const value = heartRate.getCurrent();
          if (Number.isFinite(value) && value > 0) {
            emitScalar({ channel: "heartRate", value });
          }
        } catch {
          // Ignore failed reads for this sample.
        }
      };

      heartRate.onCurrentChange(handleChange);
      stopHandlers.push(() => heartRate.offCurrentChange(handleChange));
      return true;
    } catch {
      return false;
    }
  }

  function setupBloodOxygen(): boolean {
    if (!deps.BloodOxygen) return false;

    try {
      const bloodOxygen = new deps.BloodOxygen();
      let subscribed = false;
      const generation = activeGeneration;

      const handleChange = () => {
        if (!isCurrentGeneration(generation)) return;

        try {
          const current = bloodOxygen.getCurrent();
          const value = current.value;
          if (!isFiniteNumber(value) || value < 1 || value > 100) {
            return;
          }

          const sample: Omit<PhysicalScalarSample, "tMs"> = {
            channel: "spo2",
            value: value / 100,
          };
          if (current.status !== undefined) {
            sample.status = current.status;
          }
          emitScalar(sample);
        } catch {
          // Ignore failed reads for this sample.
        }
      };

      try {
        bloodOxygen.onChange(handleChange);
        subscribed = true;
        bloodOxygen.start();
        stopHandlers.push(() => bloodOxygen.offChange(handleChange));
        stopHandlers.push(() => bloodOxygen.stop());
        return true;
      } catch {
        if (subscribed) {
          safeStop(() => bloodOxygen.offChange(handleChange));
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  function setupBarometer(): boolean {
    if (!deps.Barometer) return false;

    try {
      const barometer = new deps.Barometer();
      const generation = activeGeneration;
      const handleChange = () => {
        if (!isCurrentGeneration(generation)) return;

        try {
          const pressure = barometer.getAirPressure();
          if (Number.isFinite(pressure)) {
            emitScalar({ channel: "barometricPressure", value: pressure });
          }

          const altitude = barometer.getAltitude();
          if (Number.isFinite(altitude)) {
            emitScalar({ channel: "altitude", value: altitude });
          }
        } catch {
          // Ignore failed reads for this sample.
        }
      };

      barometer.onChange(handleChange);
      stopHandlers.push(() => barometer.offChange(handleChange));
      return true;
    } catch {
      return false;
    }
  }

  function setupCompass(): boolean {
    if (!deps.Compass) return false;

    try {
      const compass = new deps.Compass();
      let subscribed = false;
      const generation = activeGeneration;

      const handleChange = () => {
        if (!isCurrentGeneration(generation)) return;

        try {
          if (!compass.getStatus()) return;

          const value = compass.getDirectionAngle();
          if (typeof value === "number" && Number.isFinite(value)) {
            emitScalar({ channel: "compassHeading", value });
          }
        } catch {
          // Ignore failed reads for this sample.
        }
      };

      try {
        compass.onChange(handleChange);
        subscribed = true;
        compass.start();
        stopHandlers.push(() => compass.offChange(handleChange));
        stopHandlers.push(() => compass.stop());
        return true;
      } catch {
        if (subscribed) {
          safeStop(() => compass.offChange(handleChange));
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  function setupGeolocation(): boolean {
    if (!deps.Geolocation) return false;

    try {
      const geolocation = new deps.Geolocation();
      const generation = activeGeneration;
      const handleChange = () => {
        if (!isCurrentGeneration(generation)) return;

        try {
          if (geolocation.getStatus() !== "A") return;

          const latitude = geolocation.getLatitude({ format: "DD" });
          const longitude = geolocation.getLongitude({ format: "DD" });
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            emitLocation({ latitude, longitude });
          }
        } catch {
          // Ignore failed reads for this sample.
        }
      };

      geolocation.onChange(handleChange);
      stopHandlers.push(() => geolocation.offChange(handleChange));
      return true;
    } catch {
      return false;
    }
  }

  function addStatus(
    enabledChannels: string[],
    disabledChannels: string[],
    channels: string[],
    enabled: boolean,
  ): void {
    if (enabled) {
      enabledChannels.push(...channels);
      return;
    }

    disabledChannels.push(...channels);
  }

  return {
    start(startMs: number) {
      if (running) return;

      running = true;
      activeGeneration += 1;
      sessionStartMs = startMs;
      stopHandlers = [];

      const enabledChannels: string[] = [];
      const disabledChannels: string[] = [];

      addStatus(enabledChannels, disabledChannels, ["heartRate"], setupHeartRate());
      addStatus(enabledChannels, disabledChannels, ["spo2"], setupBloodOxygen());
      addStatus(
        enabledChannels,
        disabledChannels,
        ["barometricPressure", "altitude"],
        setupBarometer(),
      );
      addStatus(enabledChannels, disabledChannels, ["compassHeading"], setupCompass());
      addStatus(enabledChannels, disabledChannels, ["location"], setupGeolocation());

      callbacks.onStatus?.({ enabledChannels, disabledChannels });
    },
    stop() {
      if (!running) return;

      running = false;
      const handlers = stopHandlers;
      stopHandlers = [];

      for (const handler of handlers) {
        safeStop(handler);
      }
    },
  };
}
