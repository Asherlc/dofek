import { z } from "zod";
import type { protectedProcedure } from "../trpc.ts";

export const PROVIDER_ID = "apple_health";
export const BATCH_SIZE = 500;

/** daily_metrics columns that are integer/smallint and require Math.round() before insert */
export const INTEGER_DAILY_COLUMNS = new Set([
  "steps",
  "flights_climbed",
  "exercise_minutes",
  "stand_hours",
]);

/** metric_stream columns that are smallint/integer and require Math.round() before insert */
export const INTEGER_METRIC_STREAM_COLUMNS = new Set([
  "heart_rate",
  "power",
  "cadence",
  "gps_accuracy",
  "accumulated_power",
  "stress",
]);

export type Database = Parameters<
  Parameters<typeof protectedProcedure.mutation>[0]
>[0]["ctx"]["db"];

export const MAX_SLEEP_SESSION_GAP_MS = 90 * 60 * 1000;

// ── Zod schemas ──

export const healthKitSampleSchema = z.object({
  type: z.string(),
  value: z.number(),
  unit: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  sourceName: z.string(),
  sourceBundle: z.string(),
  uuid: z.string(),
});

export const workoutActivitySchema = z.object({
  uuid: z.string(),
  activityType: z.number(),
  startDate: z.string(),
  endDate: z.string().optional(),
  metadata: z.record(z.union([z.string(), z.number()])).optional(),
});

export const workoutSampleSchema = z.object({
  uuid: z.string(),
  workoutType: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  duration: z.number(),
  totalEnergyBurned: z.number().nullish(),
  totalDistance: z.number().nullish(),
  sourceName: z.string(),
  sourceBundle: z.string(),
  metadata: z.record(z.union([z.string(), z.number()])).optional(),
  workoutActivities: z.array(workoutActivitySchema).optional(),
});

export const routeLocationSchema = z.object({
  date: z.string(),
  lat: z.number(),
  lng: z.number(),
  altitude: z.number().nullish(),
  speed: z.number().nullish(),
  horizontalAccuracy: z.number().nullish(),
});

export const workoutRouteSchema = z.object({
  workoutUuid: z.string(),
  sourceName: z.string().nullish(),
  locations: z.array(routeLocationSchema),
});

export const sleepSampleSchema = z.object({
  uuid: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  value: z.string(),
  sourceName: z.string(),
});

export type HealthKitSample = z.infer<typeof healthKitSampleSchema>;
export type WorkoutSample = z.infer<typeof workoutSampleSchema>;
export type SleepSample = z.infer<typeof sleepSampleSchema>;
export type WorkoutRoute = z.infer<typeof workoutRouteSchema>;
export type RouteLocation = z.infer<typeof routeLocationSchema>;

// ── Type routing maps ──

/** Body measurement types and their column names */
export const bodyMeasurementTypes: Record<
  string,
  { column: string; transform?: (value: number) => number }
> = {
  HKQuantityTypeIdentifierBodyMass: { column: "weight_kg" },
  HKQuantityTypeIdentifierBodyFatPercentage: {
    column: "body_fat_pct",
    transform: (value) => value * 100,
  },
  HKQuantityTypeIdentifierBodyMassIndex: { column: "bmi" },
  HKQuantityTypeIdentifierHeight: { column: "height_cm" },
};

/** Additive daily metrics -- values that should be summed within a day */
export const additiveDailyMetricTypes: Record<
  string,
  { column: string; transform?: (value: number) => number }
> = {
  HKQuantityTypeIdentifierStepCount: { column: "steps" },
  HKQuantityTypeIdentifierActiveEnergyBurned: { column: "active_energy_kcal" },
  HKQuantityTypeIdentifierBasalEnergyBurned: { column: "basal_energy_kcal" },
  HKQuantityTypeIdentifierDistanceWalkingRunning: {
    column: "distance_km",
    transform: (value) => value / 1000,
  },
  HKQuantityTypeIdentifierDistanceCycling: {
    column: "cycling_distance_km",
    transform: (value) => value / 1000,
  },
  HKQuantityTypeIdentifierFlightsClimbed: { column: "flights_climbed" },
  HKQuantityTypeIdentifierAppleExerciseTime: { column: "exercise_minutes" },
};

/** Point-in-time daily metrics -- use latest value for the day */
export const pointInTimeDailyMetricTypes: Record<string, { column: string }> = {
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { column: "hrv" },
  HKQuantityTypeIdentifierWalkingSpeed: { column: "walking_speed" },
  HKQuantityTypeIdentifierWalkingStepLength: { column: "walking_step_length" },
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: { column: "walking_double_support_pct" },
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: { column: "walking_asymmetry_pct" },
};

/** Metric stream types and their column names */
export const metricStreamTypes: Record<string, { column: string }> = {
  HKQuantityTypeIdentifierHeartRate: { column: "heart_rate" },
  HKQuantityTypeIdentifierOxygenSaturation: { column: "spo2" },
  HKQuantityTypeIdentifierRespiratoryRate: { column: "respiratory_rate" },
  HKQuantityTypeIdentifierBloodGlucose: { column: "blood_glucose" },
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: { column: "audio_exposure" },
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: { column: "skin_temperature" },
};

/**
 * HKWorkoutActivityType rawValue → canonical snake_case activity type.
 *
 * Keys are the UInt rawValues from Apple's HKWorkoutActivityType enum.
 * Values must match the fitness.activity_type DB enum (snake_case).
 *
 * Reference: https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype
 */
export const workoutActivityTypeMap: Record<string, string> = {
  "1": "american_football",
  "2": "archery",
  "3": "australian_football",
  "4": "badminton",
  "5": "baseball",
  "6": "basketball",
  "7": "bowling",
  "8": "boxing",
  "9": "climbing",
  "10": "cricket",
  "11": "cross_training",
  "12": "curling",
  "13": "cycling",
  "14": "dance", // deprecated in iOS 14, replaced by cardioDance (77) / socialDance (78)
  "15": "dance", // danceInspiredTraining (deprecated, same as dance)
  "16": "elliptical",
  "17": "equestrian",
  "18": "fencing",
  "19": "fishing",
  "20": "functional_strength",
  "21": "golf",
  "22": "gymnastics",
  "23": "handball",
  "24": "hiking",
  "25": "hockey",
  "26": "hunting",
  "27": "lacrosse",
  "28": "martial_arts",
  "29": "mind_and_body",
  "30": "mixed_metabolic_cardio", // deprecated, replaced by mixedCardio (73)
  "31": "paddle_sports",
  "32": "play",
  "33": "preparation_and_recovery",
  "34": "racquetball",
  "35": "rowing",
  "36": "rugby",
  "37": "running",
  "38": "sailing",
  "39": "skating",
  "40": "snow_sports",
  "41": "soccer",
  "42": "softball",
  "43": "squash",
  "44": "stair_climbing",
  "45": "surfing",
  "46": "swimming",
  "47": "table_tennis",
  "48": "tennis",
  "49": "track_and_field",
  "50": "strength_training",
  "51": "volleyball",
  "52": "walking",
  "53": "water_fitness",
  "54": "water_polo",
  "55": "water_sports",
  "56": "wrestling",
  "57": "yoga",
  "58": "barre",
  "59": "core_training",
  "60": "cross_country_skiing",
  "61": "downhill_skiing",
  "62": "flexibility",
  "63": "hiit",
  "64": "jump_rope",
  "65": "kickboxing",
  "66": "pilates",
  "67": "snowboarding",
  "68": "stairs",
  "69": "step_training",
  "70": "wheelchair_walk",
  "71": "wheelchair_run",
  "72": "tai_chi",
  "73": "mixed_cardio",
  "74": "hand_cycling",
  "75": "disc_sports",
  "76": "fitness_gaming",
  "77": "cardio_dance",
  "78": "social_dance",
  "79": "pickleball",
  "80": "cooldown",
};

export const HEALTHKIT_STAGE_MAP: Record<string, string> = {
  asleepDeep: "deep",
  asleepCore: "light",
  asleep: "light",
  asleepUnspecified: "light",
  asleepREM: "rem",
  awake: "awake",
};

/** GPS channel names for route data */
export const ROUTE_CHANNELS: Array<{
  channel: string;
  getValue: (location: RouteLocation) => number | null | undefined;
  round?: boolean;
}> = [
  { channel: "lat", getValue: (location) => location.lat },
  { channel: "lng", getValue: (location) => location.lng },
  { channel: "altitude", getValue: (location) => location.altitude },
  { channel: "speed", getValue: (location) => location.speed },
  {
    channel: "gps_accuracy",
    getValue: (location) => location.horizontalAccuracy,
    round: true,
  },
];

/** Aggregated daily metric values for a single date */
export interface DailyMetricAccumulator {
  steps: number;
  activeEnergyKcal: number;
  basalEnergyKcal: number;
  distanceKm: number;
  cyclingDistanceKm: number;
  flightsClimbed: number;
  exerciseMinutes: number;
  hrv: number | null;
  walkingSpeed: number | null;
  walkingStepLength: number | null;
  walkingDoubleSupportPct: number | null;
  walkingAsymmetryPct: number | null;
}

export function createEmptyAccumulator(): DailyMetricAccumulator {
  return {
    steps: 0,
    activeEnergyKcal: 0,
    basalEnergyKcal: 0,
    distanceKm: 0,
    cyclingDistanceKm: 0,
    flightsClimbed: 0,
    exerciseMinutes: 0,
    hrv: null,
    walkingSpeed: null,
    walkingStepLength: null,
    walkingDoubleSupportPct: null,
    walkingAsymmetryPct: null,
  };
}

/** Column name to accumulator key mapping */
export const columnToAccumulatorKey: Record<string, keyof DailyMetricAccumulator> = {
  steps: "steps",
  active_energy_kcal: "activeEnergyKcal",
  basal_energy_kcal: "basalEnergyKcal",
  distance_km: "distanceKm",
  cycling_distance_km: "cyclingDistanceKm",
  flights_climbed: "flightsClimbed",
  exercise_minutes: "exerciseMinutes",
  hrv: "hrv",
  walking_speed: "walkingSpeed",
  walking_step_length: "walkingStepLength",
  walking_double_support_pct: "walkingDoubleSupportPct",
  walking_asymmetry_pct: "walkingAsymmetryPct",
};
