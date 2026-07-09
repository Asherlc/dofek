import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { provider, userProfile } from "./reference.ts";

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
    authFailureReason: text("auth_failure_reason"),
    degradationKind: text("degradation_kind"),
    durationMs: integer("duration_ms"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sync_log_user_provider_synced_at_idx").on(
      table.userId,
      table.providerId,
      table.syncedAt.desc(),
    ),
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

export const imuSession = fitness.table(
  "imu_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    providerId: text("provider_id").notNull(),
    externalId: text("external_id").notNull(),
    sessionStartAt: timestamp("session_start_at", { withTimezone: true }).notNull(),
    sampleCount: bigint("sample_count", { mode: "number" }).notNull(),
    observedHz: real("observed_hz"),
    hasGyro: boolean("has_gyro").notNull().default(false),
    accelFreqMode: bigint("accel_freq_mode", { mode: "number" }).notNull().default(1),
    gyroFreqMode: bigint("gyro_freq_mode", { mode: "number" }),
    rawData: text("raw_data"), // base64-encoded binary
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("imu_session_user_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
    index("imu_session_user_provider_idx").on(table.userId, table.providerId),
    index("imu_session_start_at_idx").on(table.sessionStartAt.desc()),
  ],
);
