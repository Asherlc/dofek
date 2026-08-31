import type { EventSubscription } from "expo-modules-core";
import HealthConnectModule from "./src/HealthConnectModule";

export type HealthKitSample = {
  type: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  sourceName: string;
  sourceBundle: string;
  uuid: string;
};
export type WorkoutSample = {
  uuid: string;
  workoutType: string;
  startDate: string;
  endDate: string;
  duration: number;
  totalDistance: number | null;
  sourceName: string;
  sourceBundle: string;
};
export type SleepSample = {
  uuid: string;
  startDate: string;
  endDate: string;
  value: string;
  sourceName: string;
};
export type RouteLocation = {
  date: string;
  lat: number;
  lng: number;
  altitude?: number;
  speed?: number;
  horizontalAccuracy?: number;
};
export type DailyStatistic = { date: string; value: number };
export type DietarySample = {
  typeIdentifier: string;
  value: number;
  unit: "kcal" | "g";
  startDate: string;
  endDate: string;
  syncIdentifier: string;
  syncVersion: number;
  foodEntryId: string;
  foodName: string;
  fingerprint: string;
};
export type HealthKitSampleUpdate = { typeIdentifier: string; updateId: string };

export async function getRequestStatus(): Promise<
  "unnecessary" | "shouldRequest" | "unavailable" | "unknown"
> {
  return HealthConnectModule.getRequestStatus();
}
export async function requestPermissions(): Promise<boolean> {
  return HealthConnectModule.requestPermissions();
}
export function hasEverAuthorized(): boolean {
  return HealthConnectModule.hasEverAuthorized();
}
export function isAvailable(): boolean {
  return HealthConnectModule.isAvailable();
}
export async function queryQuantitySamples(
  type: string,
  start: string,
  end: string,
  limit?: number,
): Promise<HealthKitSample[]> {
  return HealthConnectModule.queryQuantitySamples(type, start, end, limit ?? 0);
}
export async function queryWorkouts(start: string, end: string): Promise<WorkoutSample[]> {
  return HealthConnectModule.queryWorkouts(start, end);
}
export async function querySleepSamples(start: string, end: string): Promise<SleepSample[]> {
  return HealthConnectModule.querySleepSamples(start, end);
}
export async function queryDailyStatistics(
  type: string,
  start: string,
  end: string,
): Promise<DailyStatistic[]> {
  return HealthConnectModule.queryDailyStatistics(type, start, end);
}
export async function queryWorkoutRoutes(uuid: string): Promise<RouteLocation[]> {
  return HealthConnectModule.queryWorkoutRoutes(uuid);
}
export async function queryAnchoredSamples(
  type: string,
  start: string,
): Promise<{ queryId: string | null; samples: HealthKitSample[]; deletedUUIDs: string[] }> {
  return HealthConnectModule.queryAnchoredSamples(type, start);
}
export async function completeAnchoredQuery(
  type: string,
  queryId: string,
  succeeded: boolean,
): Promise<boolean> {
  return HealthConnectModule.completeAnchoredQuery(type, queryId, succeeded);
}
export async function writeDietarySamples(samples: DietarySample[]): Promise<boolean> {
  return HealthConnectModule.writeDietarySamples(samples);
}
export async function deleteDietarySamples(ids: string[]): Promise<number> {
  return HealthConnectModule.deleteDietarySamples(ids);
}
export function isBackgroundDeliveryEnabled(): boolean {
  return false;
}
export async function enableBackgroundDelivery(type: string): Promise<boolean> {
  return HealthConnectModule.enableBackgroundDelivery(type);
}
export async function setupBackgroundObservers(): Promise<boolean> {
  return HealthConnectModule.setupBackgroundObservers();
}
export function completeObserverUpdates(): number {
  return 0;
}
export function setObserverSyncInProgress() {}
export function teardownBackgroundObservers(): number {
  return 0;
}
export async function purgeAccountState(cutoff: string): Promise<boolean> {
  return HealthConnectModule.purgeAccountState(cutoff);
}
export function addSampleUpdateListener(): EventSubscription {
  return { remove() {} };
}
