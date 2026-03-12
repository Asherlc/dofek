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
	value: string; // "inBed", "asleepCore", "asleepDeep", "asleepREM", "awake"
	sourceName: string;
}

export interface SyncResult {
	samplesCount: number;
	startDate: string;
	endDate: string;
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
	return HealthKitModule.queryQuantitySamples(
		typeIdentifier,
		startDate,
		endDate,
		limit ?? 0,
	);
}

/** Query workouts */
export async function queryWorkouts(
	startDate: string,
	endDate: string,
): Promise<WorkoutSample[]> {
	return HealthKitModule.queryWorkouts(startDate, endDate);
}

/** Query sleep analysis */
export async function querySleepSamples(
	startDate: string,
	endDate: string,
): Promise<SleepSample[]> {
	return HealthKitModule.querySleepSamples(startDate, endDate);
}

/** Write dietary energy consumed sample to HealthKit */
export async function writeDietaryEnergy(
	calories: number,
	date: string,
): Promise<boolean> {
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

/** Register for background delivery of a HealthKit type */
export async function enableBackgroundDelivery(
	typeIdentifier: string,
): Promise<boolean> {
	return HealthKitModule.enableBackgroundDelivery(typeIdentifier);
}
