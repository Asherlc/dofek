import {
  pgSchema,
  pgTable,

  text,
  uuid,
  timestamp,
  real,
  integer,
  boolean,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// All tables live in the 'fitness' schema
const fitness = pgSchema("fitness");

// ============================================================
// Enums
// ============================================================

export const mealEnum = fitness.enum("meal", [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "other",
]);

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

export const setTypeEnum = fitness.enum("set_type", [
  "working",
  "warmup",
  "dropset",
  "failure",
]);

export const labResultStatusEnum = fitness.enum("lab_result_status", [
  "final",
  "preliminary",
  "corrected",
  "cancelled",
]);

// ============================================================
// Reference / lookup tables
// ============================================================

export const provider = fitness.table("provider", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiBaseUrl: text("api_base_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  (t) => [uniqueIndex("exercise_name_equipment_idx").on(t.name, t.equipment)],
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
  (t) => [
    uniqueIndex("exercise_alias_provider_name_idx").on(t.providerId, t.providerExerciseName),
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
  refreshToken: text("refresh_token").notNull(),
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
    externalId: text("external_id"),
    weightKg: real("weight_kg"),
    bodyFatPct: real("body_fat_pct"),
    muscleMassKg: real("muscle_mass_kg"),
    boneMassKg: real("bone_mass_kg"),
    waterPct: real("water_pct"),
    bmi: real("bmi"),
    systolicBp: integer("systolic_bp"),
    diastolicBp: integer("diastolic_bp"),
    heartPulse: integer("heart_pulse"),
    temperatureC: real("temperature_c"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("body_measurement_provider_external_idx").on(t.providerId, t.externalId)],
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
    externalId: text("external_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("strength_workout_provider_external_idx").on(t.providerId, t.externalId),
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
  (t) => [index("strength_set_workout_idx").on(t.workoutId)],
);

// ============================================================
// Cardio / endurance activities
// ============================================================

export const cardioActivity = fitness.table(
  "cardio_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id"),
    activityType: text("activity_type").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cardio_activity_provider_external_idx").on(t.providerId, t.externalId),
  ],
);

export const metricStream = fitness.table(
  "metric_stream",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    activityId: uuid("activity_id")
      .references(() => cardioActivity.id, { onDelete: "cascade" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    // Core fields — typed columns for fast queries
    heartRate: integer("heart_rate"),
    power: integer("power"),
    cadence: integer("cadence"),
    speed: real("speed"),                           // m/s
    lat: real("lat"),                               // degrees (converted from semicircles)
    lng: real("lng"),                                // degrees
    altitude: real("altitude"),                      // meters
    temperature: real("temperature"),                // celsius
    distance: real("distance"),                      // cumulative meters
    grade: real("grade"),                            // percent
    calories: integer("calories"),                   // cumulative kcal
    verticalSpeed: real("vertical_speed"),           // m/s
    spo2: real("spo2"),                                // percent (0-1)
    respiratoryRate: real("respiratory_rate"),          // breaths/min
    gpsAccuracy: integer("gps_accuracy"),            // meters
    accumulatedPower: integer("accumulated_power"),  // cumulative watts
    leftRightBalance: real("left_right_balance"),    // percent
    verticalOscillation: real("vertical_oscillation"), // mm (running)
    stanceTime: real("stance_time"),                 // ms (running)
    stanceTimePercent: real("stance_time_percent"),  // percent (running)
    stepLength: real("step_length"),                 // mm (running)
    verticalRatio: real("vertical_ratio"),            // percent (running)
    stanceTimeBalance: real("stance_time_balance"),   // percent (running)
    // Power pedaling dynamics
    leftTorqueEffectiveness: real("left_torque_effectiveness"),   // percent
    rightTorqueEffectiveness: real("right_torque_effectiveness"), // percent
    leftPedalSmoothness: real("left_pedal_smoothness"),          // percent
    rightPedalSmoothness: real("right_pedal_smoothness"),        // percent
    combinedPedalSmoothness: real("combined_pedal_smoothness"),  // percent
    // Complete raw record — every field, no data loss
    raw: jsonb("raw"),
  },
  (t) => [
    index("metric_stream_provider_time_idx").on(t.providerId, t.recordedAt),
    index("metric_stream_activity_time_idx").on(t.activityId, t.recordedAt),
  ],
);

// ============================================================
// Daily fitness metrics
// ============================================================

export const dailyMetrics = fitness.table(
  "daily_metrics",
  {
    date: date("date").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    restingHr: integer("resting_hr"),
    hrv: real("hrv"),
    vo2max: real("vo2max"),
    spo2Avg: real("spo2_avg"),
    respiratoryRateAvg: real("respiratory_rate_avg"),
    steps: integer("steps"),
    activeEnergyKcal: real("active_energy_kcal"),
    basalEnergyKcal: real("basal_energy_kcal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.date, t.providerId] })],
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
    externalId: text("external_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMinutes: integer("duration_minutes"),
    deepMinutes: integer("deep_minutes"),
    remMinutes: integer("rem_minutes"),
    lightMinutes: integer("light_minutes"),
    awakeMinutes: integer("awake_minutes"),
    efficiencyPct: real("efficiency_pct"),
    isNap: boolean("is_nap").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sleep_session_provider_external_idx").on(t.providerId, t.externalId),
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
    calories: integer("calories"),
    proteinG: real("protein_g"),
    carbsG: real("carbs_g"),
    fatG: real("fat_g"),
    fiberG: real("fiber_g"),
    waterMl: integer("water_ml"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.date, t.providerId] })],
);

export const foodEntry = fitness.table(
  "food_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id"),
    date: date("date").notNull(),
    meal: mealEnum("meal"),
    foodName: text("food_name").notNull(),
    foodDescription: text("food_description"),        // e.g. "1 cup, cooked"
    category: foodCategoryEnum("category"),
    providerFoodId: text("provider_food_id"),         // provider's food DB ID
    providerServingId: text("provider_serving_id"),   // provider's serving ID
    numberOfUnits: real("number_of_units"),
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
    calciumMg: real("calcium_mg"),
    ironMg: real("iron_mg"),
    // Raw API response
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("food_entry_provider_external_idx").on(t.providerId, t.externalId),
    index("food_entry_date_idx").on(t.date),
    index("food_entry_date_meal_idx").on(t.date, t.meal),
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
  (t) => [
    uniqueIndex("lab_result_provider_external_idx").on(t.providerId, t.externalId),
    index("lab_result_recorded_idx").on(t.recordedAt),
    index("lab_result_loinc_idx").on(t.loincCode),
    index("lab_result_test_name_idx").on(t.testName),
  ],
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
    dataType: text("data_type").notNull(), // e.g. "recovery", "sleep", "hr_stream", "workouts"
    status: text("status").notNull(), // "success" | "error"
    recordCount: integer("record_count").default(0),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sync_log_provider_type_idx").on(t.providerId, t.dataType, t.syncedAt)],
);
