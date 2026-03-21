import {
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

// All tables live in the 'fitness' schema
const fitness = pgSchema("fitness");

// Default user UUID for single-user migration path
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

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
      .default(DEFAULT_USER_ID)
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
    equipment: text("equipment"),
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

export const oauthToken = fitness.table("oauth_token", {
  providerId: text("provider_id")
    .primaryKey()
    .references(() => provider.id),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
      .default(DEFAULT_USER_ID)
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
    uniqueIndex("body_measurement_provider_external_idx").on(table.providerId, table.externalId),
    index("body_measurement_user_provider_idx").on(table.userId, table.providerId),
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
      .default(DEFAULT_USER_ID)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("strength_workout_provider_external_idx").on(table.providerId, table.externalId),
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
      .default(DEFAULT_USER_ID)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    activityType: text("activity_type").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    perceivedExertion: real("perceived_exertion"),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_provider_external_idx").on(table.providerId, table.externalId),
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
// Metric stream (TimescaleDB hypertable — DDL managed by SQL migration, not Drizzle)
// This Drizzle definition exists for type-safe queries/inserts only.
// ============================================================

export const metricStream = fitness.table(
  "metric_stream",
  {
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .default(DEFAULT_USER_ID)
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
      .default(DEFAULT_USER_ID)
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
    mindfulMinutes: integer("mindful_minutes"),
    walkingSpeed: real("walking_speed"), // m/s
    walkingStepLength: real("walking_step_length"), // cm
    walkingDoubleSupportPct: real("walking_double_support_pct"), // percent
    walkingAsymmetryPct: real("walking_asymmetry_pct"), // percent
    walkingSteadiness: real("walking_steadiness"), // 0-1
    standHours: integer("stand_hours"),
    environmentalAudioExposure: real("environmental_audio_exposure"), // dBASPL avg
    headphoneAudioExposure: real("headphone_audio_exposure"), // dBASPL avg
    skinTempC: real("skin_temp_c"), // celsius (WHOOP)
    stressHighMinutes: integer("stress_high_minutes"), // minutes of high stress (Oura)
    recoveryHighMinutes: integer("recovery_high_minutes"), // minutes of high recovery (Oura)
    resilienceLevel: text("resilience_level"), // e.g. "limited", "adequate", "solid", "strong", "exceptional"
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Business uniqueness: NULLS NOT DISTINCT index created in migration 0039
    // (Drizzle doesn't support NULLS NOT DISTINCT natively)
    index("daily_metrics_user_provider_idx").on(table.userId, table.providerId),
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
      .default(DEFAULT_USER_ID)
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
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sleep_session_provider_external_idx").on(table.providerId, table.externalId),
    index("sleep_session_user_provider_idx").on(table.userId, table.providerId),
  ],
);

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
    // Macronutrients
    calories: integer("calories"),
    proteinG: real("protein_g"),
    carbsG: real("carbs_g"),
    fatG: real("fat_g"),
    // Fat breakdown
    saturatedFatG: real("saturated_fat_g"),
    polyunsaturatedFatG: real("polyunsaturated_fat_g"),
    monounsaturatedFatG: real("monounsaturated_fat_g"),
    transFatG: real("trans_fat_g"),
    // Other macros
    cholesterolMg: real("cholesterol_mg"),
    sodiumMg: real("sodium_mg"),
    potassiumMg: real("potassium_mg"),
    fiberG: real("fiber_g"),
    sugarG: real("sugar_g"),
    // Micronutrients
    vitaminAMcg: real("vitamin_a_mcg"),
    vitaminCMg: real("vitamin_c_mg"),
    vitaminDMcg: real("vitamin_d_mcg"),
    vitaminEMg: real("vitamin_e_mg"),
    vitaminKMcg: real("vitamin_k_mcg"),
    vitaminB1Mg: real("vitamin_b1_mg"),
    vitaminB2Mg: real("vitamin_b2_mg"),
    vitaminB3Mg: real("vitamin_b3_mg"),
    vitaminB5Mg: real("vitamin_b5_mg"),
    vitaminB6Mg: real("vitamin_b6_mg"),
    vitaminB7Mcg: real("vitamin_b7_mcg"),
    vitaminB9Mcg: real("vitamin_b9_mcg"),
    vitaminB12Mcg: real("vitamin_b12_mcg"),
    calciumMg: real("calcium_mg"),
    ironMg: real("iron_mg"),
    magnesiumMg: real("magnesium_mg"),
    zincMg: real("zinc_mg"),
    seleniumMcg: real("selenium_mcg"),
    copperMg: real("copper_mg"),
    manganeseMg: real("manganese_mg"),
    chromiumMcg: real("chromium_mcg"),
    iodineMcg: real("iodine_mcg"),
    omega3Mg: real("omega3_mg"),
    omega6Mg: real("omega6_mg"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplement_user_name_idx").on(table.userId, table.name),
    index("supplement_user_idx").on(table.userId),
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
      .default(DEFAULT_USER_ID)
      .references(() => userProfile.id),
    calories: integer("calories"),
    proteinG: real("protein_g"),
    carbsG: real("carbs_g"),
    fatG: real("fat_g"),
    fiberG: real("fiber_g"),
    waterMl: integer("water_ml"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.providerId] }),
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
      .default(DEFAULT_USER_ID)
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
    // Macronutrients
    calories: integer("calories"),
    proteinG: real("protein_g"),
    carbsG: real("carbs_g"),
    fatG: real("fat_g"),
    // Fat breakdown
    saturatedFatG: real("saturated_fat_g"),
    polyunsaturatedFatG: real("polyunsaturated_fat_g"),
    monounsaturatedFatG: real("monounsaturated_fat_g"),
    transFatG: real("trans_fat_g"),
    // Other macros
    cholesterolMg: real("cholesterol_mg"),
    sodiumMg: real("sodium_mg"),
    potassiumMg: real("potassium_mg"),
    fiberG: real("fiber_g"),
    sugarG: real("sugar_g"),
    // Micronutrients
    vitaminAMcg: real("vitamin_a_mcg"),
    vitaminCMg: real("vitamin_c_mg"),
    vitaminDMcg: real("vitamin_d_mcg"),
    vitaminEMg: real("vitamin_e_mg"),
    vitaminKMcg: real("vitamin_k_mcg"),
    vitaminB1Mg: real("vitamin_b1_mg"),
    vitaminB2Mg: real("vitamin_b2_mg"),
    vitaminB3Mg: real("vitamin_b3_mg"),
    vitaminB5Mg: real("vitamin_b5_mg"),
    vitaminB6Mg: real("vitamin_b6_mg"),
    vitaminB7Mcg: real("vitamin_b7_mcg"),
    vitaminB9Mcg: real("vitamin_b9_mcg"),
    vitaminB12Mcg: real("vitamin_b12_mcg"),
    calciumMg: real("calcium_mg"),
    ironMg: real("iron_mg"),
    magnesiumMg: real("magnesium_mg"),
    zincMg: real("zinc_mg"),
    seleniumMcg: real("selenium_mcg"),
    copperMg: real("copper_mg"),
    manganeseMg: real("manganese_mg"),
    chromiumMcg: real("chromium_mcg"),
    iodineMcg: real("iodine_mcg"),
    omega3Mg: real("omega3_mg"),
    omega6Mg: real("omega6_mg"),
    // Raw API response
    raw: jsonb("raw"),
    confirmed: boolean("confirmed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("food_entry_provider_external_idx").on(table.providerId, table.externalId),
    index("food_entry_date_idx").on(table.date),
    index("food_entry_date_meal_idx").on(table.date, table.meal),
    index("food_entry_user_provider_idx").on(table.userId, table.providerId),
  ],
);

// ============================================================
// Lab results (clinical records from Apple Health / FHIR)
// ============================================================

export const labResult = fitness.table(
  "lab_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    userId: uuid("user_id")
      .notNull()
      .default(DEFAULT_USER_ID)
      .references(() => userProfile.id),
    externalId: text("external_id"),
    testName: text("test_name").notNull(),
    loincCode: text("loinc_code"),
    value: real("value"),
    valueText: text("value_text"),
    unit: text("unit"),
    referenceRangeLow: real("reference_range_low"),
    referenceRangeHigh: real("reference_range_high"),
    referenceRangeText: text("reference_range_text"),
    panelName: text("panel_name"),
    status: labResultStatusEnum("status"),
    sourceName: text("source_name"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lab_result_provider_external_idx").on(table.providerId, table.externalId),
    index("lab_result_recorded_idx").on(table.recordedAt),
    index("lab_result_loinc_idx").on(table.loincCode),
    index("lab_result_test_name_idx").on(table.testName),
    index("lab_result_user_provider_idx").on(table.userId, table.providerId),
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
      .default(DEFAULT_USER_ID)
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
    uniqueIndex("health_event_provider_external_idx").on(table.providerId, table.externalId),
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
      .default(DEFAULT_USER_ID)
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
      .default(DEFAULT_USER_ID)
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
// Journal entries — daily behavioral self-reports (WHOOP journal, etc.)
// ============================================================

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
      .default(DEFAULT_USER_ID)
      .references(() => userProfile.id),
    question: text("question").notNull(),
    answerText: text("answer_text"),
    answerNumeric: real("answer_numeric"),
    impactScore: real("impact_score"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journal_entry_provider_date_question_idx").on(
      table.providerId,
      table.date,
      table.question,
    ),
    index("journal_entry_date_idx").on(table.date),
    index("journal_entry_user_provider_idx").on(table.userId, table.providerId),
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
      .default(DEFAULT_USER_ID)
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
      .default(DEFAULT_USER_ID)
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
    uniqueIndex("dexa_scan_provider_external_idx").on(table.providerId, table.externalId),
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
