import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { buildNutrientColumns } from "./nutrient-columns.ts";
import { getTokenUserId } from "./token-user-context.ts";

// All tables live in the 'fitness' schema
const fitness = pgSchema("fitness");

// Stable user ID used in integration tests and fixtures.
export const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

function resolveImplicitUserId(): string {
  const userId = getTokenUserId();
  if (!userId) {
    throw new Error("Missing user context for implicit user_id default");
  }
  return userId;
}

// ============================================================
// Enums
// ============================================================

export const mealEnum = fitness.enum("meal", ["breakfast", "lunch", "dinner", "snack", "other"]);

export const foodCategoryEnum = fitness.enum("food_category", [
  // FatSecret standard categories
  "beans_and_legumes",
  "beverages",
  "breads_and_cereals",
  "cheese_milk_and_dairy",
  "eggs",
  "fast_food",
  "fish_and_seafood",
  "fruit",
  "meat",
  "nuts_and_seeds",
  "pasta_rice_and_noodles",
  "salads",
  "sauces_spices_and_spreads",
  "snacks",
  "soups",
  "sweets_candy_and_desserts",
  "vegetables",
  // Custom categories
  "supplement",
  "other",
]);

export const setTypeEnum = fitness.enum("set_type", ["working", "warmup", "dropset", "failure"]);

export const labResultStatusEnum = fitness.enum("lab_result_status", [
  "final",
  "preliminary",
  "corrected",
  "cancelled",
]);

export const activityTypeEnum = fitness.enum("activity_type", [
  // Cycling subtypes
  "cycling",
  "road_cycling",
  "mountain_biking",
  "gravel_cycling",
  "indoor_cycling",
  "virtual_cycling",
  "e_bike_cycling",
  "cyclocross",
  "track_cycling",
  "bmx",
  // Endurance
  "running",
  "trail_running",
  "swimming",
  "open_water_swimming",
  "walking",
  "hiking",
  // Strength / gym
  "strength",
  "strength_training",
  "functional_strength",
  "gym",
  // Mind / body
  "yoga",
  "pilates",
  "tai_chi",
  "mind_and_body",
  "meditation",
  "breathwork",
  "stretching",
  "flexibility",
  "barre",
  // Cardio / HIIT
  "elliptical",
  "rowing",
  "cardio",
  "hiit",
  "mixed_cardio",
  "mixed_metabolic_cardio",
  "stair_climbing",
  "stairmaster",
  "stairs",
  "step_training",
  "jump_rope",
  "fitness_gaming",
  // Cross training
  "cross_training",
  "bootcamp",
  "circuit_training",
  "functional_fitness",
  "core",
  "core_training",
  "boxing",
  "kickboxing",
  "martial_arts",
  "group_exercise",
  // Winter sports
  "skiing",
  "cross_country_skiing",
  "downhill_skiing",
  "snowboarding",
  "snow_sports",
  "snowshoeing",
  "skating",
  // Water sports
  "surfing",
  "kayaking",
  "sailing",
  "paddle_sports",
  "paddleboarding",
  "paddling",
  "water_fitness",
  "water_polo",
  "water_sports",
  "aqua_fitness",
  "underwater_diving",
  "diving",
  "snorkeling",
  // Racquet sports
  "tennis",
  "table_tennis",
  "squash",
  "racquetball",
  "badminton",
  "pickleball",
  "padel",
  "paddle_racquet",
  // Team sports
  "basketball",
  "soccer",
  "football",
  "american_football",
  "australian_football",
  "rugby",
  "hockey",
  "ice_hockey",
  "lacrosse",
  "baseball",
  "softball",
  "volleyball",
  "cricket",
  "handball",
  // Other sports
  "golf",
  "disc_golf",
  "climbing",
  "rock_climbing",
  "dance",
  "dancing",
  "cardio_dance",
  "social_dance",
  "triathlon",
  "multisport",
  "hand_cycling",
  "wheelchair_walk",
  "wheelchair_run",
  "disc_sports",
  // Outdoor / recreation
  "equestrian",
  "fencing",
  "fishing",
  "hunting",
  "gymnastics",
  "archery",
  "bowling",
  "curling",
  "wrestling",
  "track_and_field",
  "play",
  "navigation",
  "geocaching",
  // Air sports
  "skydiving",
  "paragliding",
  // Activity lifecycle
  "preparation_and_recovery",
  "cooldown",
  "transition",
  // Catch-all
  "other",
]);

// ============================================================
// User profile — multi-user support
// ============================================================

export const userProfile = fitness.table("user_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").unique(),
  birthDate: date("birth_date"),
  maxHr: smallint("max_hr"),
  restingHr: smallint("resting_hr"),
  ftp: smallint("ftp"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Reference / lookup tables
// ============================================================

export const provider = fitness.table(
  "provider",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    apiBaseUrl: text("api_base_url"),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("provider_user_name_idx").on(table.userId, table.name)],
);

export const exercise = fitness.table(
  "exercise",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    muscleGroup: text("muscle_group"),
    muscleGroups: text("muscle_groups").array(),
    equipment: text("equipment"),
    exerciseType: text("exercise_type"),
    movement: text("movement"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("exercise_name_equipment_idx").on(table.name, table.equipment)],
);

export const exerciseAlias = fitness.table(
  "exercise_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercise.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    providerExerciseId: text("provider_exercise_id"),
    providerExerciseName: text("provider_exercise_name").notNull(),
  },
  (table) => [
    uniqueIndex("exercise_alias_provider_name_idx").on(
      table.providerId,
      table.providerExerciseName,
    ),
  ],
);

// ============================================================
// OAuth tokens
// ============================================================

export const oauthToken = fitness.table(
  "oauth_token",
  {
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: text("scopes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.providerId] }),
    index("oauth_token_provider_idx").on(table.providerId),
    index("oauth_token_user_idx").on(table.userId),
  ],
);

// ============================================================
// Webhook subscriptions
// ============================================================

export const webhookSubscription = fitness.table(
  "webhook_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider ID (e.g., "strava", "fitbit"). For app-level webhooks, provider_id is NULL. */
    providerId: text("provider_id").references(() => provider.id),
    /** Provider name for app-level subscriptions where there's no per-user provider row */
    providerName: text("provider_name").notNull(),
    /** Subscription ID from the provider's API (for unsubscribe) */
    subscriptionExternalId: text("subscription_external_id"),
    /** Random token used for validation challenges */
    verifyToken: text("verify_token").notNull(),
    /** HMAC key or signing secret from the provider (for signature verification) */
    signingSecret: text("signing_secret"),
    /** Current subscription state */
    status: text("status").notNull().default("active"),
    /** When this subscription expires (Oura requires renewal) */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Provider-specific metadata (JSON) */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_subscription_provider_id_idx").on(table.providerId),
    index("webhook_subscription_provider_name_idx").on(table.providerName),
  ],
);

// ============================================================
// Body composition
// ============================================================

export const bodyMeasurement = fitness.table(
  "body_measurement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    weightKg: real("weight_kg"),
    bodyFatPct: real("body_fat_pct"),
    muscleMassKg: real("muscle_mass_kg"),
    boneMassKg: real("bone_mass_kg"),
    waterPct: real("water_pct"),
    bmi: real("bmi"),
    heightCm: real("height_cm"),
    waistCircumferenceCm: real("waist_circumference_cm"),
    systolicBp: integer("systolic_bp"),
    diastolicBp: integer("diastolic_bp"),
    heartPulse: integer("heart_pulse"),
    temperatureC: real("temperature_c"),
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("body_measurement_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("body_measurement_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Body measurement type catalog + junction table
// ============================================================

export const measurementType = fitness.table("measurement_type", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  unit: text("unit"),
  category: text("category").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isInteger: boolean("is_integer").notNull().default(false),
});

export const bodyMeasurementValue = fitness.table(
  "body_measurement_value",
  {
    bodyMeasurementId: uuid("body_measurement_id")
      .notNull()
      .references(() => bodyMeasurement.id, { onDelete: "cascade" }),
    measurementTypeId: text("measurement_type_id")
      .notNull()
      .references(() => measurementType.id),
    value: real("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bodyMeasurementId, table.measurementTypeId] }),
    index("body_measurement_value_entry_idx").on(table.bodyMeasurementId),
    index("body_measurement_value_type_idx").on(table.measurementTypeId),
  ],
);

// ============================================================
// Strength training
// ============================================================

export const strengthWorkout = fitness.table(
  "strength_workout",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    rawMskStrainScore: real("raw_msk_strain_score"),
    scaledMskStrainScore: real("scaled_msk_strain_score"),
    cardioStrainScore: real("cardio_strain_score"),
    cardioStrainContributionPercent: real("cardio_strain_contribution_percent"),
    mskStrainContributionPercent: real("msk_strain_contribution_percent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("strength_workout_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
  ],
);

export const strengthSet = fitness.table(
  "strength_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => strengthWorkout.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercise.id),
    exerciseIndex: integer("exercise_index").notNull(),
    setIndex: integer("set_index").notNull(),
    setType: setTypeEnum("set_type").default("working"),
    weightKg: real("weight_kg"),
    reps: integer("reps"),
    distanceMeters: real("distance_meters"),
    durationSeconds: integer("duration_seconds"),
    strapLocation: text("strap_location"),
    strapLocationLaterality: text("strap_location_laterality"),
    rpe: real("rpe"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("strength_set_workout_idx").on(table.workoutId)],
);

// ============================================================
// Cardio / endurance activities
// ============================================================

export const activity = fitness.table(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    activityType: activityTypeEnum("activity_type").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    perceivedExertion: real("perceived_exertion"),
    percentRecorded: real("percent_recorded"),
    sourceName: text("source_name"),
    timezone: text("timezone"), // IANA timezone (e.g. "America/New_York")
    stravaId: text("strava_id"), // Strava activity ID for cross-provider linking
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("activity_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Sport settings — per-sport zone configuration
// ============================================================

export const sportSettings = fitness.table(
  "sport_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    sport: text("sport").notNull(),
    ftp: smallint("ftp"),
    thresholdHr: smallint("threshold_hr"),
    thresholdPacePerKm: real("threshold_pace_per_km"),
    powerZonePcts: jsonb("power_zone_pcts"),
    hrZonePcts: jsonb("hr_zone_pcts"),
    paceZonePcts: jsonb("pace_zone_pcts"),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sport_settings_user_sport_date_idx").on(
      table.userId,
      table.sport,
      table.effectiveFrom,
    ),
    index("sport_settings_user_idx").on(table.userId),
  ],
);

// ============================================================
// Activity intervals / laps
// ============================================================

export const activityInterval = fitness.table(
  "activity_interval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    intervalIndex: integer("interval_index").notNull(),
    label: text("label"),
    intervalType: text("interval_type"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("activity_interval_activity_idx").on(table.activityId, table.intervalIndex)],
);

// ============================================================
// Sensor sample (TimescaleDB hypertable — DDL managed by SQL migration, not Drizzle)
// Unified time-series table for ALL sensor data using a "medium" layout.
// Replaces metric_stream, inertial_measurement_unit_sample, and orientation_sample.
// This Drizzle definition exists for type-safe queries/inserts only.
//
// Design:
//   - `channel` identifies what's measured (e.g., "heart_rate", "power", "imu")
//   - `scalar` stores single numeric values (HR, power, cadence, speed, etc.)
//   - `vector` stores multi-axis data as real[] (accel [x,y,z], quaternion [w,x,y,z])
//   - Dedup: per (activity, channel), pick the provider with the most samples
//   - `source_type` is informational only (debugging/auditing), not used for priority
// ============================================================

export const sensorSample = fitness.table(
  "sensor_sample",
  {
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    deviceId: text("device_id"),
    sourceType: text("source_type").notNull(), // 'ble', 'file', 'api' (informational only)
    channel: text("channel").notNull(), // 'heart_rate', 'power', 'imu', 'orientation', etc.
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "cascade" }),
    scalar: real("scalar"), // single numeric value
    vector: real("vector").array(), // multi-axis data (e.g., [x, y, z] for accel)
  },
  (table) => [
    index("sensor_sample_activity_channel_time_idx").on(
      table.activityId,
      table.channel,
      table.recordedAt,
    ),
    index("sensor_sample_user_channel_time_idx").on(table.userId, table.channel, table.recordedAt),
    index("sensor_sample_provider_time_idx").on(table.providerId, table.recordedAt),
  ],
);

// ============================================================
// Legacy tables — retained during migration, will be dropped in a future migration.
// All new code should use sensorSample instead.
// ============================================================

/** @deprecated Use sensorSample instead */
export const metricStream = fitness.table(
  "metric_stream",
  {
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    // Core fields — typed columns for fast queries
    heartRate: smallint("heart_rate"),
    power: smallint("power"),
    cadence: smallint("cadence"),
    speed: real("speed"), // m/s
    lat: real("lat"), // degrees
    lng: real("lng"), // degrees
    altitude: real("altitude"), // meters
    temperature: real("temperature"), // celsius
    grade: real("grade"), // percent
    verticalSpeed: real("vertical_speed"), // m/s
    spo2: real("spo2"), // percent (0-1)
    respiratoryRate: real("respiratory_rate"), // breaths/min
    gpsAccuracy: smallint("gps_accuracy"), // meters
    accumulatedPower: integer("accumulated_power"), // cumulative watts
    stress: smallint("stress"),
    // Running dynamics
    leftRightBalance: real("left_right_balance"), // percent
    verticalOscillation: real("vertical_oscillation"), // mm (running)
    stanceTime: real("stance_time"), // ms (running)
    stanceTimePercent: real("stance_time_percent"), // percent (running)
    stepLength: real("step_length"), // mm (running)
    verticalRatio: real("vertical_ratio"), // percent (running)
    stanceTimeBalance: real("stance_time_balance"), // percent (running)
    groundContactTime: real("ground_contact_time"), // ms
    strideLength: real("stride_length"), // meters
    formPower: real("form_power"), // watts
    legSpringStiff: real("leg_spring_stiff"),
    airPower: real("air_power"), // watts
    // Power pedaling dynamics
    leftTorqueEffectiveness: real("left_torque_effectiveness"), // percent
    rightTorqueEffectiveness: real("right_torque_effectiveness"), // percent
    leftPedalSmoothness: real("left_pedal_smoothness"), // percent
    rightPedalSmoothness: real("right_pedal_smoothness"), // percent
    combinedPedalSmoothness: real("combined_pedal_smoothness"), // percent
    // Apple Health / medical
    bloodGlucose: real("blood_glucose"), // mmol/L
    audioExposure: real("audio_exposure"), // dBASPL
    skinTemperature: real("skin_temperature"), // celsius
    electrodermalActivity: real("electrodermal_activity"), // microsiemens
    rrIntervalMs: smallint("rr_interval_ms"), // milliseconds (beat-to-beat R-R interval from PPG)
    // Source device/app name (e.g., "Apple Watch", "Wahoo TICKR")
    sourceName: text("source_name"),
    // Complete raw record — every field, no data loss
    raw: jsonb("raw"),
  },
  (table) => [
    index("metric_stream_provider_time_idx").on(table.providerId, table.recordedAt),
    index("metric_stream_activity_time_idx").on(table.activityId, table.recordedAt),
    index("metric_stream_user_provider_idx").on(table.userId, table.providerId),
  ],
);

/** @deprecated Use sensorSample instead */
export const inertialMeasurementUnitSample = fitness.table(
  "inertial_measurement_unit_sample",
  {
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    deviceId: text("device_id").notNull(),
    deviceType: text("device_type").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    x: real("x").notNull(),
    y: real("y").notNull(),
    z: real("z").notNull(),
    gyroscopeX: real("gyroscope_x"),
    gyroscopeY: real("gyroscope_y"),
    gyroscopeZ: real("gyroscope_z"),
  },
  (table) => [index("inertial_measurement_unit_user_time_idx").on(table.userId, table.recordedAt)],
);

/** @deprecated Use sensorSample instead */
export const orientationSample = fitness.table(
  "orientation_sample",
  {
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    deviceId: text("device_id").notNull(),
    quaternionW: real("quaternion_w").notNull(),
    quaternionX: real("quaternion_x").notNull(),
    quaternionY: real("quaternion_y").notNull(),
    quaternionZ: real("quaternion_z").notNull(),
  },
  (table) => [index("orientation_sample_user_time_idx").on(table.userId, table.recordedAt)],
);

// ============================================================
// Daily fitness metrics
// ============================================================

export const dailyMetrics = fitness.table(
  "daily_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    restingHr: integer("resting_hr"),
    hrv: real("hrv"),
    vo2max: real("vo2max"),
    spo2Avg: real("spo2_avg"),
    respiratoryRateAvg: real("respiratory_rate_avg"),
    steps: integer("steps"),
    activeEnergyKcal: real("active_energy_kcal"),
    basalEnergyKcal: real("basal_energy_kcal"),
    distanceKm: real("distance_km"), // walking + running
    cyclingDistanceKm: real("cycling_distance_km"),
    flightsClimbed: integer("flights_climbed"),
    exerciseMinutes: integer("exercise_minutes"),
    walkingSpeed: real("walking_speed"), // m/s
    walkingStepLength: real("walking_step_length"), // cm
    walkingDoubleSupportPct: real("walking_double_support_pct"), // percent
    walkingAsymmetryPct: real("walking_asymmetry_pct"), // percent
    walkingSteadiness: real("walking_steadiness"), // 0-1
    standHours: integer("stand_hours"),
    skinTempC: real("skin_temp_c"), // celsius (WHOOP)
    stressHighMinutes: integer("stress_high_minutes"), // minutes of high stress (Oura)
    recoveryHighMinutes: integer("recovery_high_minutes"), // minutes of high recovery (Oura)
    resilienceLevel: text("resilience_level"), // e.g. "limited", "adequate", "solid", "strong", "exceptional"
    pushCount: integer("push_count"),
    wheelchairDistanceKm: real("wheelchair_distance_km"),
    uvExposure: real("uv_exposure"),
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Business uniqueness: NULLS NOT DISTINCT index created in migration 0058
    // (Drizzle doesn't support NULLS NOT DISTINCT natively)
    index("daily_metrics_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Daily metric type catalog + junction table
// ============================================================

export const dailyMetricType = fitness.table("daily_metric_type", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  unit: text("unit"),
  category: text("category").notNull(),
  priorityCategory: text("priority_category").notNull().default("activity"),
  sortOrder: integer("sort_order").notNull().default(0),
  isInteger: boolean("is_integer").notNull().default(false),
});

export const dailyMetricValue = fitness.table(
  "daily_metric_value",
  {
    dailyMetricsId: uuid("daily_metrics_id")
      .notNull()
      .references(() => dailyMetrics.id, { onDelete: "cascade" }),
    metricTypeId: text("metric_type_id")
      .notNull()
      .references(() => dailyMetricType.id),
    value: real("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.dailyMetricsId, table.metricTypeId] }),
    index("daily_metric_value_entry_idx").on(table.dailyMetricsId),
    index("daily_metric_value_type_idx").on(table.metricTypeId),
  ],
);

// ============================================================
// Sleep
// ============================================================

export const sleepSession = fitness.table(
  "sleep_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    deepMinutes: integer("deep_minutes"),
    remMinutes: integer("rem_minutes"),
    lightMinutes: integer("light_minutes"),
    awakeMinutes: integer("awake_minutes"),
    efficiencyPct: real("efficiency_pct"),
    sleepType: text("sleep_type"),
    sleepNeedBaselineMinutes: integer("sleep_need_baseline_minutes"),
    sleepNeedFromDebtMinutes: integer("sleep_need_from_debt_minutes"),
    sleepNeedFromStrainMinutes: integer("sleep_need_from_strain_minutes"),
    sleepNeedFromNapMinutes: integer("sleep_need_from_nap_minutes"),
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sleep_session_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("sleep_session_user_provider_idx").on(table.userId, table.providerId),
  ],
);

export const sleepStage = fitness.table(
  "sleep_stage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sleepSession.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(), // "deep", "light", "rem", "awake"
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sleep_stage_session_idx").on(table.sessionId, table.startedAt)],
);

// ============================================================
// Nutrition data — shared nutrient values for food entries and supplements
// ============================================================

export const nutritionData = fitness.table("nutrition_data", {
  id: uuid("id").primaryKey().defaultRandom(),
  ...buildNutrientColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// Supplements — per-user supplement stack definitions
// ============================================================

export const supplement = fitness.table(
  "supplement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    name: text("name").notNull(),
    amount: real("amount"),
    unit: text("unit"),
    form: text("form"),
    description: text("description"),
    meal: mealEnum("meal"),
    sortOrder: integer("sort_order").notNull().default(0),
    nutritionDataId: uuid("nutrition_data_id").references(() => nutritionData.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplement_user_name_idx").on(table.userId, table.name),
    index("supplement_user_idx").on(table.userId),
  ],
);

// ============================================================
// Nutrient catalog + junction tables
// ============================================================

export const nutrient = fitness.table("nutrient", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  unit: text("unit").notNull(),
  category: text("category").notNull(),
  rda: real("rda"),
  sortOrder: integer("sort_order").notNull().default(0),
  openFoodFactsKey: text("open_food_facts_key"),
  conversionFactor: real("conversion_factor").notNull().default(1),
});

export const foodEntryNutrient = fitness.table(
  "food_entry_nutrient",
  {
    foodEntryId: uuid("food_entry_id")
      .notNull()
      .references(() => foodEntry.id, { onDelete: "cascade" }),
    nutrientId: text("nutrient_id")
      .notNull()
      .references(() => nutrient.id),
    amount: real("amount").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.foodEntryId, table.nutrientId] }),
    index("food_entry_nutrient_entry_idx").on(table.foodEntryId),
  ],
);

export const supplementNutrient = fitness.table(
  "supplement_nutrient",
  {
    supplementId: uuid("supplement_id")
      .notNull()
      .references(() => supplement.id, { onDelete: "cascade" }),
    nutrientId: text("nutrient_id")
      .notNull()
      .references(() => nutrient.id),
    amount: real("amount").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.supplementId, table.nutrientId] }),
    index("supplement_nutrient_supplement_idx").on(table.supplementId),
  ],
);

// ============================================================
// Nutrition
// ============================================================

export const nutritionDaily = fitness.table(
  "nutrition_daily",
  {
    date: date("date").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    ...buildNutrientColumns(),
    waterMl: integer("water_ml"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.date, table.providerId] }),
    index("nutrition_daily_user_provider_idx").on(table.userId, table.providerId),
  ],
);

export const foodEntry = fitness.table(
  "food_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    date: date("date").notNull(),
    meal: mealEnum("meal"),
    foodName: text("food_name").notNull(),
    foodDescription: text("food_description"),
    category: foodCategoryEnum("category"),
    providerFoodId: text("provider_food_id"),
    providerServingId: text("provider_serving_id"),
    numberOfUnits: real("number_of_units"),
    loggedAt: timestamp("logged_at", { withTimezone: true }),
    barcode: text("barcode"),
    servingUnit: text("serving_unit"),
    servingWeightGrams: real("serving_weight_grams"),
    nutritionDataId: uuid("nutrition_data_id").references(() => nutritionData.id),
    // Raw API response
    raw: jsonb("raw"),
    confirmed: boolean("confirmed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("food_entry_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("food_entry_date_idx").on(table.date),
    index("food_entry_date_meal_idx").on(table.date, table.meal),
    index("food_entry_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Lab panels & results (clinical records from Apple Health / FHIR)
// ============================================================

export const labPanel = fitness.table(
  "lab_panel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    name: text("name").notNull(),
    loincCode: text("loinc_code"),
    status: labResultStatusEnum("status"),
    sourceName: text("source_name"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lab_panel_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("lab_panel_recorded_idx").on(table.recordedAt),
    index("lab_panel_user_provider_idx").on(table.userId, table.providerId),
  ],
);

export const labResult = fitness.table(
  "lab_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    panelId: uuid("panel_id").references(() => labPanel.id),
    externalId: text("external_id"),
    testName: text("test_name").notNull(),
    loincCode: text("loinc_code"),
    value: real("value"),
    valueText: text("value_text"),
    unit: text("unit"),
    referenceRangeLow: real("reference_range_low"),
    referenceRangeHigh: real("reference_range_high"),
    referenceRangeText: text("reference_range_text"),
    status: labResultStatusEnum("status"),
    sourceName: text("source_name"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lab_result_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("lab_result_recorded_idx").on(table.recordedAt),
    index("lab_result_loinc_idx").on(table.loincCode),
    index("lab_result_test_name_idx").on(table.testName),
    index("lab_result_panel_idx").on(table.panelId),
    index("lab_result_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Medications (FHIR MedicationRequest)
// ============================================================

export const medication = fitness.table(
  "medication",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    name: text("name").notNull(),
    status: text("status"),
    authoredOn: date("authored_on"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    dosageText: text("dosage_text"),
    route: text("route"),
    form: text("form"),
    rxnormCode: text("rxnorm_code"),
    prescriberName: text("prescriber_name"),
    reasonText: text("reason_text"),
    reasonSnomedCode: text("reason_snomed_code"),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("medication_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("medication_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Conditions / Diagnoses (FHIR Condition)
// ============================================================

export const condition = fitness.table(
  "condition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    name: text("name").notNull(),
    clinicalStatus: text("clinical_status"),
    verificationStatus: text("verification_status"),
    icd10Code: text("icd10_code"),
    snomedCode: text("snomed_code"),
    onsetDate: date("onset_date"),
    abatementDate: date("abatement_date"),
    recordedDate: date("recorded_date"),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("condition_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("condition_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Allergies / Intolerances (FHIR AllergyIntolerance)
// ============================================================

export const allergyIntolerance = fitness.table(
  "allergy_intolerance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    name: text("name").notNull(),
    type: text("type"),
    clinicalStatus: text("clinical_status"),
    verificationStatus: text("verification_status"),
    rxnormCode: text("rxnorm_code"),
    onsetDate: date("onset_date"),
    reactions: jsonb("reactions"),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("allergy_intolerance_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("allergy_intolerance_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Medication Dose Events (iOS 26 HKMedicationDoseEvent)
// ============================================================

export const medicationDoseEvent = fitness.table(
  "medication_dose_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    medicationName: text("medication_name").notNull(),
    medicationConceptId: text("medication_concept_id"),
    doseStatus: text("dose_status").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("medication_dose_event_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("medication_dose_event_user_provider_idx").on(table.userId, table.providerId),
    index("medication_dose_event_recorded_idx").on(table.recordedAt),
  ],
);

// ============================================================
// Generic health events / catch-all
// ============================================================

export const healthEvent = fitness.table(
  "health_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    type: text("type").notNull(), // HK type identifier
    value: real("value"), // numeric value (if any)
    valueText: text("value_text"), // category/string value (if any)
    unit: text("unit"),
    sourceName: text("source_name"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("health_event_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("health_event_type_time_idx").on(table.type, table.startDate),
    index("health_event_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Authentication — links external OAuth identities to users
// ============================================================

export const authAccount = fitness.table(
  "auth_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    authProvider: text("auth_provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email"),
    name: text("name"),
    groups: text("groups").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_account_provider_id_idx").on(table.authProvider, table.providerAccountId),
    index("auth_account_user_idx").on(table.userId),
  ],
);

// ============================================================
// Slack installations — multi-workspace bot token storage
// ============================================================

export const slackInstallation = fitness.table(
  "slack_installation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id").notNull().unique(),
    teamName: text("team_name"),
    botToken: text("bot_token").notNull(),
    botId: text("bot_id"),
    botUserId: text("bot_user_id"),
    appId: text("app_id"),
    installerSlackUserId: text("installer_slack_user_id"),
    rawInstallation: jsonb("raw_installation").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("slack_installation_team_idx").on(table.teamId)],
);

// ============================================================
// Sessions — database-backed session tokens
// ============================================================

export const session = fitness.table(
  "session",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("session_user_idx").on(table.userId),
    index("session_expires_idx").on(table.expiresAt),
  ],
);

// ============================================================
// User settings (key-value store, scoped per user)
// ============================================================

export const userSettings = fitness.table(
  "user_settings",
  {
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

// ============================================================
// Sync log — tracks reliability per provider per data type
// ============================================================

export const syncLog = fitness.table(
  "sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    dataType: text("data_type").notNull(),
    status: text("status").notNull(),
    recordCount: integer("record_count").default(0),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sync_log_provider_type_idx").on(table.providerId, table.dataType, table.syncedAt),
    index("sync_log_synced_at_idx").on(table.syncedAt),
  ],
);

// ============================================================
// Journal — normalized questions + daily self-report answers
// ============================================================

export const journalQuestion = fitness.table("journal_question", {
  slug: text("slug").primaryKey(),
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),
  dataType: text("data_type").notNull(),
  unit: text("unit"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journalEntry = fitness.table(
  "journal_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    questionSlug: text("question_slug")
      .notNull()
      .references(() => journalQuestion.slug),
    answerText: text("answer_text"),
    answerNumeric: real("answer_numeric"),
    impactScore: real("impact_score"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journal_entry_user_date_question_provider_idx").on(
      table.userId,
      table.date,
      table.questionSlug,
      table.providerId,
    ),
    index("journal_entry_date_idx").on(table.date),
    index("journal_entry_user_provider_idx").on(table.userId, table.providerId),
    index("journal_entry_question_slug_idx").on(table.questionSlug),
  ],
);

// ============================================================
// Life Events / Markers
// ============================================================

export const lifeEvents = fitness.table(
  "life_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    startedAt: date("started_at").notNull(),
    endedAt: date("ended_at"),
    category: text("category"),
    ongoing: boolean("ongoing").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("life_events_started_at_idx").on(table.startedAt)],
);

// ============================================================
// Breathwork sessions
// ============================================================

export const breathworkSession = fitness.table(
  "breathwork_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    techniqueId: text("technique_id").notNull(),
    rounds: integer("rounds").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("breathwork_session_user_idx").on(table.userId),
    index("breathwork_session_started_at_idx").on(table.startedAt.desc()),
  ],
);

// ============================================================
// Shared health reports
// ============================================================

export const sharedReport = fitness.table(
  "shared_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    shareToken: text("share_token").notNull().unique(),
    reportType: text("report_type").notNull(), // 'weekly', 'monthly', 'healthspan'
    reportData: jsonb("report_data").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("shared_report_user_idx").on(table.userId)],
);

// ============================================================
// Menstrual cycle tracking
// ============================================================

export const menstrualPeriod = fitness.table(
  "menstrual_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("menstrual_period_user_start_idx").on(table.userId, table.startDate),
    index("menstrual_period_user_idx").on(table.userId),
  ],
);

// ============================================================
// DEXA scans (BodySpec, etc.)
// ============================================================

export const dexaScan = fitness.table(
  "dexa_scan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .$defaultFn(resolveImplicitUserId)
      .references(() => userProfile.id),
    externalId: text("external_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    scannerModel: text("scanner_model"),
    // Total body composition
    totalFatMassKg: real("total_fat_mass_kg"),
    totalLeanMassKg: real("total_lean_mass_kg"),
    totalBoneMassKg: real("total_bone_mass_kg"),
    totalMassKg: real("total_mass_kg"),
    bodyFatPct: real("body_fat_pct"),
    androidGynoidRatio: real("android_gynoid_ratio"),
    // Visceral fat
    visceralFatMassKg: real("visceral_fat_mass_kg"),
    visceralFatVolumeCm3: real("visceral_fat_volume_cm3"),
    // Total bone density
    totalBoneMineralDensity: real("total_bone_mineral_density"), // g/cm2
    boneDensityTPercentile: real("bone_density_t_percentile"), // vs peak (30yo), 1-99
    boneDensityZPercentile: real("bone_density_z_percentile"), // vs age/sex matched, 1-99
    // Resting metabolic rate
    restingMetabolicRateKcal: real("resting_metabolic_rate_kcal"), // primary estimate
    restingMetabolicRateRaw: jsonb("resting_metabolic_rate_raw"), // all formula estimates (proprietary)
    // Percentiles (proprietary reference populations)
    percentiles: jsonb("percentiles"),
    // Patient intake
    heightInches: real("height_inches"),
    weightPounds: real("weight_pounds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dexa_scan_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("dexa_scan_user_provider_idx").on(table.userId, table.providerId),
    index("dexa_scan_recorded_at_idx").on(table.recordedAt.desc()),
  ],
);

export const dexaScanRegion = fitness.table(
  "dexa_scan_region",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanId: uuid("scan_id")
      .notNull()
      .references(() => dexaScan.id, { onDelete: "cascade" }),
    region: text("region").notNull(), // android, gynoid, left_arm, right_arm, left_leg, right_leg, trunk
    // Body composition
    fatMassKg: real("fat_mass_kg"),
    leanMassKg: real("lean_mass_kg"),
    boneMassKg: real("bone_mass_kg"),
    totalMassKg: real("total_mass_kg"),
    tissueFatPct: real("tissue_fat_pct"), // fat % of soft tissue in region
    regionFatPct: real("region_fat_pct"), // this region's fat as % of total body fat
    // Bone density
    boneMineralDensity: real("bone_mineral_density"), // g/cm2
    boneAreaCm2: real("bone_area_cm2"),
    boneMineralContentG: real("bone_mineral_content_g"),
    zScorePercentile: real("z_score_percentile"), // age/sex matched, 1-99
    tScorePercentile: real("t_score_percentile"), // vs peak (30yo), 1-99
  },
  (table) => [
    uniqueIndex("dexa_scan_region_scan_region_idx").on(table.scanId, table.region),
    index("dexa_scan_region_scan_idx").on(table.scanId),
  ],
);

// ============================================================
// Training export watermark — tracks last export time per table
// ============================================================

export const trainingExportWatermark = fitness.table("training_export_watermark", {
  id: uuid("id").primaryKey().defaultRandom(),
  tableName: text("table_name").notNull().unique(),
  lastExportedAt: timestamp("last_exported_at", { withTimezone: true }).notNull(),
  rowCount: bigint("row_count", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
