import type { InertialMeasurementUnitService } from "./inertial-measurement-unit-service.ts";
import type { GpsSample, LocationAdapter } from "./location-service.ts";
import { captureException } from "./telemetry";

export type RecordingState = "idle" | "recording" | "paused" | "saving" | "error";

export interface RecordingSnapshot {
  state: RecordingState;
  activityType: string | null;
  samples: ReadonlyArray<GpsSample>;
  elapsedMs: number;
  distanceMeters: number;
  currentSpeedMs: number | null;
  error: string | null;
}

export interface RecordingTrpcClient {
  activityRecording: {
    save: {
      mutate(input: {
        activityType: string;
        startedAt: string;
        endedAt: string;
        name: string | null;
        notes: string | null;
        sourceName: string;
        samples: Array<{
          recordedAt: string;
          lat: number | null;
          lng: number | null;
          gpsAccuracy: number | null;
          altitude: number | null;
          speed: number | null;
        }>;
      }): Promise<{ activityId: string }>;
    };
  };
}

/** Haversine distance between two lat/lng points in meters */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const EARTH_RADIUS_METERS = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const haversineA =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversineA), Math.sqrt(1 - haversineA));
}

/** Compute total distance from an array of GPS samples */
export function totalDistance(samples: ReadonlyArray<GpsSample>): number {
  let distance = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (!prev || !curr) {
      continue;
    }
    distance += haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
  }
  return distance;
}

export interface ActivityRecorder {
  getSnapshot(): RecordingSnapshot;
  start(activityType: string): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
  save(name: string | null, notes: string | null): Promise<string>;
  discard(): void;
  onUpdate(callback: () => void): () => void;
}

export function createActivityRecorder(
  locationAdapter: LocationAdapter,
  trpcClient: RecordingTrpcClient,
  sourceName: string,
  inertialMeasurementUnitService?: InertialMeasurementUnitService,
): ActivityRecorder {
  let state: RecordingState = "idle";
  let activityType: string | null = null;
  let samples: GpsSample[] = [];
  let startTime: number | null = null;
  let pauseStart: number | null = null;
  let totalPausedMs = 0;
  let error: string | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function getElapsedMs(): number {
    if (startTime === null) return 0;
    const now = Date.now();
    const paused = pauseStart !== null ? now - pauseStart : 0;
    return now - startTime - totalPausedMs - paused;
  }

  function getCurrentSpeed(): number | null {
    const latest = samples.at(-1);
    return latest?.speed ?? null;
  }

  return {
    getSnapshot(): RecordingSnapshot {
      return {
        state,
        activityType,
        samples,
        elapsedMs: getElapsedMs(),
        distanceMeters: totalDistance(samples),
        currentSpeedMs: getCurrentSpeed(),
        error,
      };
    },

    async start(type: string) {
      if (state !== "idle") return;

      const granted = await locationAdapter.requestPermissions();
      if (!granted) {
        state = "error";
        error = "Location permissions not granted";
        notify();
        return;
      }

      activityType = type;
      samples = [];
      startTime = Date.now();
      totalPausedMs = 0;
      pauseStart = null;
      error = null;
      state = "recording";
      notify();

      await locationAdapter.startUpdates((sample) => {
        if (state === "recording") {
          samples.push(sample);
          notify();
        }
      });

      // Ensure accelerometer recording is active (best-effort, non-blocking)
      inertialMeasurementUnitService?.ensureRecording().catch((error: unknown) => {
        // Best-effort — don't disrupt GPS recording
        captureException(error, { source: "activity-recording" });
      });
    },

    pause() {
      if (state !== "recording") return;
      state = "paused";
      pauseStart = Date.now();
      locationAdapter.stopUpdates();
      notify();
    },

    async resume() {
      if (state !== "paused") return;
      if (pauseStart !== null) {
        totalPausedMs += Date.now() - pauseStart;
        pauseStart = null;
      }
      state = "recording";
      notify();

      await locationAdapter.startUpdates((sample) => {
        if (state === "recording") {
          samples.push(sample);
          notify();
        }
      });
    },

    stop() {
      if (state !== "recording" && state !== "paused") return;
      if (pauseStart !== null) {
        totalPausedMs += Date.now() - pauseStart;
        pauseStart = null;
      }
      locationAdapter.stopUpdates();
      // Keep state as "recording" — the UI will transition to save/discard
      // We just stop collecting. The state machine stays ready for save() or discard().
      state = "saving";
      notify();
    },

    async save(name: string | null, notes: string | null): Promise<string> {
      if (state !== "saving" || !activityType || !startTime) {
        throw new Error(`Cannot save in state: ${state}`);
      }

      const startedAt = new Date(startTime).toISOString();
      const endedAt = new Date(startTime + getElapsedMs()).toISOString();

      try {
        const result = await trpcClient.activityRecording.save.mutate({
          activityType,
          startedAt,
          endedAt,
          name,
          notes,
          sourceName,
          samples: samples.map((s) => ({
            recordedAt: s.recordedAt,
            lat: s.lat,
            lng: s.lng,
            gpsAccuracy: s.gpsAccuracy,
            altitude: s.altitude,
            speed: s.speed,
          })),
        });

        // Sync accelerometer data for the activity window (best-effort)
        try {
          await inertialMeasurementUnitService?.syncForTimeRange(startedAt, endedAt);
        } catch {
          // Best-effort — don't fail the activity save
        }

        state = "idle";
        activityType = null;
        samples = [];
        startTime = null;
        totalPausedMs = 0;
        error = null;
        notify();

        return result.activityId;
      } catch (err) {
        state = "error";
        error = err instanceof Error ? err.message : "Failed to save activity";
        notify();
        throw err;
      }
    },

    discard() {
      locationAdapter.stopUpdates();
      state = "idle";
      activityType = null;
      samples = [];
      startTime = null;
      totalPausedMs = 0;
      pauseStart = null;
      error = null;
      notify();
    },

    onUpdate(callback: () => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
