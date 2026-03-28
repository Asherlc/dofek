import type { EventSubscription } from "expo-modules-core";
import HealthKitModule from "./src/HealthKitModule";

export interface HealthKitSample {
  type: string;
  value: number;
  unit: string;
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
  sourceName: string;
  sourceBundle: string;
  uuid: string;
}

export interface WorkoutSample {
  uuid: string;
  workoutType: string;
  startDate: string;
  endDate: string;
  duration: number; // seconds
  totalEnergyBurned: number | null; // kcal
  totalDistance: number | null; // meters
  sourceName: string;
  sourceBundle: string;
}

export interface SleepSample {
  uuid: string;
  startDate: string;
  endDate: string;
  value: string; // "inBed", "asleep", "asleepCore", "asleepDeep", "asleepREM", "awake"
  sourceName: string;
}

export interface DailyStatistic {
  date: string; // YYYY-MM-DD (local timezone)
  value: number;
}

export interface SyncResult {
  samplesCount: number;
  startDate: string;
  endDate: string;
}

/** Check whether HealthKit authorization has already been requested.
 * Returns "unnecessary" if the user has already been asked,
 * "shouldRequest" if permissions still need to be requested,
 * or "unavailable"/"unknown" for edge cases. */
export async function getRequestStatus(): Promise<
  "unnecessary" | "shouldRequest" | "unavailable" | "unknown"
> {
  return HealthKitModule.getRequestStatus();
}

/** Request HealthKit read/write permissions for all data types we need */
export async function requestPermissions(): Promise<boolean> {
  return HealthKitModule.requestPermissions();
}

/** Check if HealthKit is available on this device */
export function isAvailable(): boolean {
  return HealthKitModule.isAvailable();
}

/** Query quantity samples (heart rate, weight, body fat, etc.) */
export async function queryQuantitySamples(
  typeIdentifier: string,
  startDate: string,
  endDate: string,
  limit?: number,
): Promise<HealthKitSample[]> {
  return HealthKitModule.queryQuantitySamples(typeIdentifier, startDate, endDate, limit ?? 0);
}

/** Query workouts */
export async function queryWorkouts(startDate: string, endDate: string): Promise<WorkoutSample[]> {
  return HealthKitModule.queryWorkouts(startDate, endDate);
}

/** Query sleep analysis */
export async function querySleepSamples(
  startDate: string,
  endDate: string,
): Promise<SleepSample[]> {
  return HealthKitModule.querySleepSamples(startDate, endDate);
}

/** Query deduplicated daily statistics for a cumulative quantity type.
 * Uses HKStatisticsCollectionQuery which properly handles source deduplication
 * (e.g., iPhone + Apple Watch both counting steps for the same time period). */
export async function queryDailyStatistics(
  typeIdentifier: string,
  startDate: string,
  endDate: string,
): Promise<DailyStatistic[]> {
  return HealthKitModule.queryDailyStatistics(typeIdentifier, startDate, endDate);
}

/** Write dietary energy consumed sample to HealthKit */
export async function writeDietaryEnergy(calories: number, date: string): Promise<boolean> {
  return HealthKitModule.writeDietaryEnergy(calories, date);
}

/** Get the anchor for incremental syncing of a given type */
export async function getAnchor(typeIdentifier: string): Promise<number> {
  return HealthKitModule.getAnchor(typeIdentifier);
}

/** Query samples added/deleted since the last anchor (for incremental sync) */
export async function queryAnchoredSamples(
  typeIdentifier: string,
  anchor: number,
): Promise<{
  samples: HealthKitSample[];
  deletedUUIDs: string[];
  newAnchor: number;
}> {
  return HealthKitModule.queryAnchoredSamples(typeIdentifier, anchor);
}

/** Check if background delivery was previously enabled on this device */
export function isBackgroundDeliveryEnabled(): boolean {
  return HealthKitModule.isBackgroundDeliveryEnabled();
}

/** Register for background delivery of a HealthKit type */
export async function enableBackgroundDelivery(typeIdentifier: string): Promise<boolean> {
  return HealthKitModule.enableBackgroundDelivery(typeIdentifier);
}

/** Set up HKObserverQuery instances for all read types.
 * When new samples arrive, fires an "onHealthKitSampleUpdate" event. */
export async function setupBackgroundObservers(): Promise<boolean> {
  return HealthKitModule.setupBackgroundObservers();
}

/** Listen for HealthKit sample update events from background observers.
 * Returns a subscription that can be removed with `.remove()`. */
export function addSampleUpdateListener(
  callback: (event: { typeIdentifier: string }) => void,
): EventSubscription {
  return HealthKitModule.addListener("onHealthKitSampleUpdate", callback);
}
