import * as Location from "expo-location";

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

/** Real implementation backed by expo-location */
export function createLocationAdapter(): LocationAdapter {
  let subscription: Location.LocationSubscription | null = null;

  return {
    async requestPermissions() {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return false;

      // Also request background for when app is backgrounded during recording
      const background = await Location.requestBackgroundPermissionsAsync();
      // Foreground is sufficient to start; background is nice-to-have
      return status === "granted" || background.status === "granted";
    },

    async startUpdates(callback) {
      subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 5, // meters — balance accuracy vs battery
          timeInterval: 1000, // minimum ms between updates
        },
        (location) => {
          callback({
            recordedAt: new Date(location.timestamp).toISOString(),
            lat: location.coords.latitude,
            lng: location.coords.longitude,
            gpsAccuracy: location.coords.accuracy,
            altitude: location.coords.altitude,
            speed:
              location.coords.speed != null && location.coords.speed >= 0
                ? location.coords.speed
                : null,
          });
        },
      );
    },

    async stopUpdates() {
      if (subscription) {
        subscription.remove();
        subscription = null;
      }
    },
  };
}
