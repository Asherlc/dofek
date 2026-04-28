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

/** A sub-activity within a workout (iOS 16+). Each represents a distinct
 *  segment — e.g. a different exercise or interval within a single workout. */
export interface WorkoutActivity {
  uuid: string;
  activityType: number; // HKWorkoutActivityType raw value
  startDate: string;
  endDate?: string;
  /** Arbitrary metadata set by the recording app on this activity */
  metadata?: Record<string, string | number>;
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
  /** Arbitrary metadata set by the recording app on the workout */
  metadata?: Record<string, string | number>;
  /** Sub-activities within the workout (iOS 16+) */
  workoutActivities?: WorkoutActivity[];
}

export interface SleepSample {
  uuid: string;
  startDate: string;
  endDate: string;
  value: string; // "inBed", "asleep", "asleepCore", "asleepDeep", "asleepREM", "awake"
  sourceName: string;
}

export interface RouteLocation {
  date: string; // ISO 8601
  lat: number;
  lng: number;
  altitude?: number;
  speed?: number;
  horizontalAccuracy?: number;
}

export interface DailyStatistic {
  date: string; // YYYY-MM-DD (local timezone)
  value: number;
}

export interface DietarySample {
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

/** Check if the user has ever completed the HealthKit authorization flow.
 * Returns true even if new types have been added since the last authorization —
 * this ensures syncing of already-authorized types continues uninterrupted.
 * Use `getRequestStatus()` separately to determine if new permissions should be prompted. */
export function hasEverAuthorized(): boolean {
  return HealthKitModule.hasEverAuthorized();
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

/** Query GPS route locations for a workout by its UUID */
export async function queryWorkoutRoutes(workoutUuid: string): Promise<RouteLocation[]> {
  return HealthKitModule.queryWorkoutRoutes(workoutUuid);
}

/** Write Dofek-owned dietary samples to HealthKit */
export async function writeDietarySamples(samples: DietarySample[]): Promise<boolean> {
  return HealthKitModule.writeDietarySamples(samples);
}

/** Delete Dofek-owned dietary samples by HealthKit sync identifier */
export async function deleteDietarySamples(syncIdentifiers: string[]): Promise<number> {
  return HealthKitModule.deleteDietarySamples(syncIdentifiers);
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
