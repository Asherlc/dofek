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

export interface SyncResult {
  samplesCount: number;
  startDate: string;
  endDate: string;
}

export interface HealthKitSampleUpdate {
  typeIdentifier: string;
  updateId: string;
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
 * Use `getRequestStatus()` separately to determine if current permissions are complete
 * or if new permissions should be prompted. */
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

/** Delete Dofek-owned dietary samples by HealthKit sync identifier */
export async function deleteDietarySamples(syncIdentifiers: string[]): Promise<number> {
  return HealthKitModule.deleteDietarySamples(syncIdentifiers);
}

/** Query samples added/deleted since the last successful query.
 * The native module persists HealthKit's opaque query anchor per type. */
export async function queryAnchoredSamples(
  typeIdentifier: string,
  initialStartDate: string,
): Promise<{
  queryId: string | null;
  samples: HealthKitSample[];
  deletedUUIDs: string[];
}> {
  return HealthKitModule.queryAnchoredSamples(typeIdentifier, initialStartDate);
}

/** Persist or discard the anchor returned by an incremental query.
 * Anchors are committed only after the corresponding server mutation succeeds. */
export async function completeAnchoredQuery(
  typeIdentifier: string,
  queryId: string,
  succeeded: boolean,
): Promise<boolean> {
  return HealthKitModule.completeAnchoredQuery(typeIdentifier, queryId, succeeded);
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

/** Complete specific HealthKit observer callbacks after their serialized sync settles. */
export function completeObserverUpdates(updateIds: string[], succeeded: boolean): number {
  return HealthKitModule.completeObserverUpdates(updateIds, succeeded);
}

/** Tell native observers whether JavaScript is still processing a delivery.
 * Pass `true` when sync starts; pass `false` when sync finishes. Clearing to
 * `false` is ignored while native still has pending observer updates or catch-up. */
export function setObserverSyncInProgress(inProgress: boolean): void {
  HealthKitModule.setObserverSyncInProgress(inProgress);
}

/** Stop native observer queries and complete every callback that is still pending. */
export function teardownBackgroundObservers(): number {
  return HealthKitModule.teardownBackgroundObservers();
}

/** Clear Dofek-owned observer, anchor, and background-delivery state.
 * This does not delete HealthKit samples owned by iOS or other apps. */
export async function purgeAccountState(deviceErasureCutoff: string): Promise<boolean> {
  return HealthKitModule.purgeAccountState(deviceErasureCutoff);
}

/** Listen for HealthKit sample update events from background observers.
 * Returns a subscription that can be removed with `.remove()`. */
export function addSampleUpdateListener(
  callback: (event: HealthKitSampleUpdate) => void,
): EventSubscription {
  return HealthKitModule.addListener("onHealthKitSampleUpdate", callback);
}
