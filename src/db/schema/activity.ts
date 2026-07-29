import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import {
  activityModalityEnum,
  canonicalActivityTypeEnum,
  climbingAttemptOutcomeEnum,
  climbingClimbTypeEnum,
  climbingFailureReasonEnum,
  climbingGradeSystemEnum,
  climbingHoldTypeEnum,
  fingerLoadingExerciseEnum,
  fingerLoadingGripPositionEnum,
  fingerLoadingLateralityEnum,
  setTypeEnum,
  sleepStageNameEnum,
} from "./enums.ts";
import { exercise, provider, userProfile } from "./reference.ts";

// ============================================================
// Strength training
// ============================================================

export const strengthSet = fitness.table(
  "strength_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercise.id, { onDelete: "cascade" }),
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
  (table) => [index("strength_set_activity_idx").on(table.activityId)],
);

export const fingerLoadingEntry = fitness.table(
  "finger_loading_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    exercise: fingerLoadingExerciseEnum("exercise").notNull(),
    edgeSizeMm: real("edge_size_mm"),
    gripPosition: fingerLoadingGripPositionEnum("grip_position"),
    externalLoadKg: real("external_load_kg").notNull(),
    bodyweightKg: real("bodyweight_kg").notNull(),
    laterality: fingerLoadingLateralityEnum("laterality").notNull(),
    setCount: integer("set_count").notNull(),
    holdDurationSeconds: real("hold_duration_seconds").notNull(),
    restIntervalSeconds: integer("rest_interval_seconds").notNull(),
    rpe: real("rpe"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("finger_loading_entry_activity_idx").on(table.activityId),
    check(
      "finger_loading_entry_edge_size_positive",
      sql`${table.edgeSizeMm} IS NULL OR ${table.edgeSizeMm} > 0`,
    ),
    check("finger_loading_entry_bodyweight_positive", sql`${table.bodyweightKg} > 0`),
    check(
      "finger_loading_entry_effective_load_positive",
      sql`${table.bodyweightKg} + ${table.externalLoadKg} > 0`,
    ),
    check("finger_loading_entry_set_count_positive", sql`${table.setCount} > 0`),
    check("finger_loading_entry_hold_duration_positive", sql`${table.holdDurationSeconds} > 0`),
    check("finger_loading_entry_rest_interval_nonnegative", sql`${table.restIntervalSeconds} >= 0`),
    check(
      "finger_loading_entry_rpe_range",
      sql`${table.rpe} IS NULL OR (${table.rpe} >= 0 AND ${table.rpe} <= 10)`,
    ),
  ],
);

// ============================================================
// Rock climbing
// ============================================================

export const climbingEntry = fitness.table(
  "climbing_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    climbType: climbingClimbTypeEnum("climb_type").notNull(),
    gradeSystem: climbingGradeSystemEnum("grade_system").notNull(),
    grade: text("grade").notNull(),
    sent: boolean("sent"),
    attemptCount: integer("attempt_count").default(1),
    wallAngleDegrees: real("wall_angle_degrees"),
    holdType: climbingHoldTypeEnum("hold_type"),
    routeName: text("route_name"),
    locationName: text("location_name"),
    sourceName: text("source_name"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("climbing_entry_activity_idx").on(table.activityId),
    index("climbing_entry_grade_lookup_idx").on(table.climbType, table.gradeSystem, table.grade),
    uniqueIndex("climbing_entry_activity_external_id_idx")
      .on(table.activityId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    check("climbing_entry_grade_nonempty", sql`btrim(${table.grade}) <> ''`),
    check("climbing_entry_attempt_count_positive", sql`${table.attemptCount} > 0`),
    check(
      "climbing_entry_aggregate_pair",
      sql`(${table.sent} IS NULL) = (${table.attemptCount} IS NULL)`,
    ),
    check(
      "climbing_entry_wall_angle_range",
      sql`${table.wallAngleDegrees} IS NULL OR (${table.wallAngleDegrees} >= -90 AND ${table.wallAngleDegrees} <= 90)`,
    ),
    check(
      "climbing_entry_external_id_nonempty",
      sql`${table.externalId} IS NULL OR btrim(${table.externalId}) <> ''`,
    ),
    check(
      "climbing_entry_route_name_nonempty",
      sql`${table.routeName} IS NULL OR btrim(${table.routeName}) <> ''`,
    ),
    check(
      "climbing_entry_location_name_nonempty",
      sql`${table.locationName} IS NULL OR btrim(${table.locationName}) <> ''`,
    ),
    check(
      "climbing_entry_source_name_nonempty",
      sql`${table.sourceName} IS NULL OR btrim(${table.sourceName}) <> ''`,
    ),
  ],
);

export const climbingAttempt = fitness.table(
  "climbing_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    climbingEntryId: uuid("climbing_entry_id")
      .notNull()
      .references(() => climbingEntry.id, { onDelete: "cascade" }),
    attemptIndex: integer("attempt_index").notNull(),
    outcome: climbingAttemptOutcomeEnum("outcome").notNull(),
    failureReason: climbingFailureReasonEnum("failure_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("climbing_attempt_entry_idx").on(table.climbingEntryId),
    uniqueIndex("climbing_attempt_entry_index_idx").on(table.climbingEntryId, table.attemptIndex),
    check("climbing_attempt_index_positive", sql`${table.attemptIndex} > 0`),
    check(
      "climbing_attempt_failure_reason",
      sql`(${table.outcome} = 'sent' AND ${table.failureReason} IS NULL)
        OR (${table.outcome} = 'failed' AND ${table.failureReason} IS NOT NULL)`,
    ),
    check(
      "climbing_attempt_notes_nonempty",
      sql`${table.notes} IS NULL OR btrim(${table.notes}) <> ''`,
    ),
  ],
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
    externalId: text("external_id").notNull(),
    canonicalType: canonicalActivityTypeEnum("canonical_type").notNull(),
    providerType: text("provider_type").notNull(),
    modality: activityModalityEnum("modality"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    name: text("name"),
    notes: text("notes"),
    perceivedExertion: real("perceived_exertion"),
    sourceName: text("source_name"),
    timezone: text("timezone"), // IANA timezone (e.g. "America/New_York")
    startUtcOffsetMinutes: bigint("start_utc_offset_minutes", { mode: "number" }),
    endUtcOffsetMinutes: bigint("end_utc_offset_minutes", { mode: "number" }),
    localTimeSource: text("local_time_source").notNull().default("unknown"),
    stravaId: text("strava_id"), // Strava activity ID for cross-provider linking
    raw: jsonb("raw"),
    providerAbsentAt: timestamp("provider_absent_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("activity_user_provider_idx").on(table.userId, table.providerId),
    check(
      "activity_local_time_context_check",
      sql`(
        ${table.localTimeSource} = 'unknown'
        AND ${table.startUtcOffsetMinutes} IS NULL
        AND ${table.endUtcOffsetMinutes} IS NULL
      ) OR (
        ${table.localTimeSource} IN ('provider_timezone', 'device_timezone')
        AND NULLIF(btrim(${table.timezone}), '') IS NOT NULL
        AND ${table.startUtcOffsetMinutes} BETWEEN -840 AND 840
        AND (${table.endedAt} IS NULL OR ${table.endUtcOffsetMinutes} BETWEEN -840 AND 840)
      ) OR (
        ${table.localTimeSource} IN ('provider_offset', 'device_offset')
        AND ${table.timezone} IS NULL
        AND ${table.startUtcOffsetMinutes} BETWEEN -840 AND 840
        AND (${table.endedAt} IS NULL OR ${table.endUtcOffsetMinutes} BETWEEN -840 AND 840)
      )`,
    ),
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
    hrv: real("hrv"),
    spo2Avg: real("spo2_avg"),
    respiratoryRateAvg: real("respiratory_rate_avg"),
    steps: integer("steps"),
    activeEnergyKcal: real("active_energy_kcal"),
    basalEnergyKcal: real("basal_energy_kcal"),
    distanceKm: real("distance_km"), // walking + running
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
      .references(() => dailyMetricType.id, { onDelete: "restrict" }),
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
    stagingAvailable: boolean("staging_available").notNull().default(false),
    sleepType: text("sleep_type"),
    isNap: boolean("is_nap").notNull().default(false),
    sleepNeedBaselineMinutes: integer("sleep_need_baseline_minutes"),
    sleepNeedFromDebtMinutes: integer("sleep_need_from_debt_minutes"),
    sleepNeedFromStrainMinutes: integer("sleep_need_from_strain_minutes"),
    sleepNeedFromNapMinutes: integer("sleep_need_from_nap_minutes"),
    sourceName: text("source_name"),
    timezone: text("timezone"),
    startUtcOffsetMinutes: bigint("start_utc_offset_minutes", { mode: "number" }),
    endUtcOffsetMinutes: bigint("end_utc_offset_minutes", { mode: "number" }),
    localTimeSource: text("local_time_source").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sleep_session_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("sleep_session_user_provider_idx").on(table.userId, table.providerId),
    check(
      "sleep_session_local_time_context_check",
      sql`(
        ${table.localTimeSource} = 'unknown'
        AND ${table.timezone} IS NULL
        AND ${table.startUtcOffsetMinutes} IS NULL
        AND ${table.endUtcOffsetMinutes} IS NULL
      ) OR (
        ${table.localTimeSource} IN ('provider_timezone', 'device_timezone')
        AND NULLIF(btrim(${table.timezone}), '') IS NOT NULL
        AND ${table.startUtcOffsetMinutes} BETWEEN -840 AND 840
        AND (${table.endedAt} IS NULL OR ${table.endUtcOffsetMinutes} BETWEEN -840 AND 840)
      ) OR (
        ${table.localTimeSource} IN ('provider_offset', 'device_offset')
        AND ${table.timezone} IS NULL
        AND ${table.startUtcOffsetMinutes} BETWEEN -840 AND 840
        AND (${table.endedAt} IS NULL OR ${table.endUtcOffsetMinutes} BETWEEN -840 AND 840)
      )`,
    ),
  ],
);

export const sleepStage = fitness.table(
  "sleep_stage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sleepSession.id, { onDelete: "cascade" }),
    stage: sleepStageNameEnum("stage").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    sourceName: text("source_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sleep_stage_session_idx").on(table.sessionId, table.startedAt)],
);
