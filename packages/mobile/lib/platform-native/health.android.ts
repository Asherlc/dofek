import type { EventSubscription } from "expo-modules-core";

export type HealthKitSample = { type: string; value: number; unit: string; startDate: string; endDate: string; sourceName: string; sourceBundle: string; uuid: string };
export type WorkoutSample = { uuid: string; workoutType: string; startDate: string; endDate: string; duration: number; totalDistance: number | null; sourceName: string; sourceBundle: string };
export type SleepSample = { uuid: string; startDate: string; endDate: string; value: string; sourceName: string };
export type RouteLocation = { date: string; lat: number; lng: number; altitude?: number; speed?: number; horizontalAccuracy?: number };
export type DailyStatistic = { date: string; value: number };
export type DietarySample = { typeIdentifier: string; value: number; unit: "kcal" | "g"; startDate: string; endDate: string; syncIdentifier: string; syncVersion: number; foodEntryId: string; foodName: string; fingerprint: string };
export type HealthKitSampleUpdate = { typeIdentifier: string; updateId: string };

const unavailable = () => new Error("Health Connect is not configured. Connect Health Connect in Settings to sync Android health data.");
const reject = async (): Promise<never> => { throw unavailable(); };

export const healthGateway = { kind: "health-connect" as const };
export async function getRequestStatus() { return "unavailable" as const; }
export async function requestPermissions() { return reject(); }
export function hasEverAuthorized() { return false; }
export function isAvailable() { return false; }
export const queryQuantitySamples = reject as (type: string, start: string, end: string, limit?: number) => Promise<HealthKitSample[]>;
export const queryWorkouts = reject as (start: string, end: string) => Promise<WorkoutSample[]>;
export const querySleepSamples = reject as (start: string, end: string) => Promise<SleepSample[]>;
export const queryDailyStatistics = reject as (type: string, start: string, end: string) => Promise<DailyStatistic[]>;
export const queryWorkoutRoutes = reject as (uuid: string) => Promise<RouteLocation[]>;
export const queryAnchoredSamples = reject as (type: string, start: string) => Promise<{ queryId: string | null; samples: HealthKitSample[]; deletedUUIDs: string[] }>;
export const completeAnchoredQuery = reject as (type: string, queryId: string, succeeded: boolean) => Promise<boolean>;
export const writeDietarySamples = reject as (samples: DietarySample[]) => Promise<boolean>;
export const deleteDietarySamples = reject as (ids: string[]) => Promise<number>;
export function isBackgroundDeliveryEnabled() { return false; }
export const enableBackgroundDelivery = reject as (type: string) => Promise<boolean>;
export const setupBackgroundObservers = reject as () => Promise<boolean>;
export function completeObserverUpdates() { return 0; }
export function setObserverSyncInProgress() {}
export function teardownBackgroundObservers() { return 0; }
export const purgeAccountState = reject as (cutoff: string) => Promise<boolean>;
export function addSampleUpdateListener(): EventSubscription { return { remove() {} }; }
