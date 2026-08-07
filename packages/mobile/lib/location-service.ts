import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { captureException } from "./telemetry";

/** Background task identifier for activity GPS recording. */
export const BACKGROUND_LOCATION_TASK = "dofek-activity-location";

/** A single GPS sample captured during recording */
export interface GpsSample {
  recordedAt: string;
  lat: number;
  lng: number;
  gpsAccuracy: number | null;
  altitude: number | null;
  speed: number | null;
}

/** Abstraction over expo-location for testability */
export interface LocationAdapter {
  requestPermissions(): Promise<boolean>;
  startUpdates(callback: (sample: GpsSample) => void): Promise<void>;
  stopUpdates(): Promise<void>;
}

function toGpsSample(location: Location.LocationObject): GpsSample {
  return {
    recordedAt: new Date(location.timestamp).toISOString(),
    lat: location.coords.latitude,
    lng: location.coords.longitude,
    gpsAccuracy: location.coords.accuracy,
    altitude: location.coords.altitude,
    speed:
      location.coords.speed != null && location.coords.speed >= 0 ? location.coords.speed : null,
  };
}

// The active recording's sample listener. The background task (registered at
// module scope below) forwards samples here, so GPS keeps recording while the
// app is suspended in the background — `watchPositionAsync` only fires in the
// foreground, which silently dropped points when the user backgrounded a run.
let activeSampleListener: ((sample: GpsSample) => void) | null = null;

// Must be registered in the global module scope (expo-task-manager requirement).
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
  BACKGROUND_LOCATION_TASK,
  async ({ data, error }) => {
    if (error) {
      captureException(error, { source: "background-location-task" });
      return;
    }
    const listener = activeSampleListener;
    if (!listener) return;
    for (const location of data.locations) {
      listener(toGpsSample(location));
    }
  },
);

/** Real implementation backed by expo-location background updates */
export function createLocationAdapter(): LocationAdapter {
  return {
    async requestPermissions() {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== "granted") return false;

      // "Always" permission lets recording survive iOS suspending or relaunching
      // the app mid-workout. "When In Use" is enough to start and keeps updating
      // in the background while the location indicator is shown, so a denied
      // background prompt is not fatal.
      await Location.requestBackgroundPermissionsAsync();
      return true;
    },

    async startUpdates(callback) {
      activeSampleListener = callback;
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5, // meters — balance accuracy vs battery
        timeInterval: 1000, // minimum ms between updates
        activityType: Location.ActivityType.Fitness,
        showsBackgroundLocationIndicator: true,
        pausesUpdatesAutomatically: false,
      });
    },

    async stopUpdates() {
      activeSampleListener = null;
      const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      if (started) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      }
    },
  };
}
