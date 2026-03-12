// TODO: Implement native Swift module via Expo Modules API
// This will be a custom native module that wraps HealthKit
// See: https://docs.expo.dev/modules/overview/

export interface HealthKitSample {
  type: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  sourceName: string;
}

export async function requestPermissions(): Promise<boolean> {
  console.warn("HealthKit module not yet implemented - requires native Swift module");
  return false;
}

export async function querySamples(
  type: string,
  startDate: Date,
  endDate: Date,
): Promise<HealthKitSample[]> {
  console.warn(
    `HealthKit module not yet implemented - querySamples(${type}, ${startDate.toISOString()}, ${endDate.toISOString()})`,
  );
  return [];
}

export async function startBackgroundSync(): Promise<void> {
  console.warn("HealthKit background sync not yet implemented");
}
