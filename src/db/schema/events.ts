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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { provider, userProfile } from "./reference.ts";

// ============================================================
// Provider data deletion — generation fence + transactional outbox
// ============================================================

export const providerDataGeneration = fitness.table(
  "provider_data_generation",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    currentGeneration: bigint("current_generation", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.providerId] }),
    check("provider_data_generation_nonnegative", sql`${table.currentGeneration} >= 0`),
  ],
);

export const providerDataDeletionOutbox = fitness.table(
  "provider_data_deletion_outbox",
  {
    eventId: uuid("event_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => [
    index("provider_data_deletion_outbox_dispatch_idx").on(table.status, table.createdAt),
    check("provider_data_deletion_outbox_generation_positive", sql`${table.generation} > 0`),
    check(
      "provider_data_deletion_outbox_status_valid",
      sql`${table.status} IN ('pending', 'dispatched', 'completed', 'failed')`,
    ),
  ],
);

// ============================================================
// File upload — durable R2 upload lifecycle + transactional outbox
// ============================================================

export const fileUpload = fitness.table(
  "file_upload",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    importType: text("import_type").notNull(),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    expectedSha256: text("expected_sha256").notNull(),
    verifiedSha256: text("verified_sha256"),
    r2MultipartUploadId: text("r2_multipart_upload_id"),
    state: text("state").notNull().default("initiated"),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    partSizeBytes: bigint("part_size_bytes", { mode: "number" }).notNull(),
    completionParts: jsonb("completion_parts"),
    importJobId: text("import_job_id"),
    importSince: timestamp("import_since", { withTimezone: true }).notNull(),
    weightUnit: text("weight_unit"),
    progressPercent: bigint("progress_percent", { mode: "number" }).notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    objectDeletedAt: timestamp("object_deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("file_upload_object_key_key").on(table.objectKey),
    unique("file_upload_import_job_id_key").on(table.importJobId),
    index("file_upload_owner_updated_idx").on(table.userId, table.updatedAt.desc()),
    index("file_upload_reconcile_idx").on(table.state, table.expiresAt, table.updatedAt),
    check("file_upload_expected_size_positive", sql`${table.expectedSizeBytes} > 0`),
    check("file_upload_part_size_valid", sql`${table.partSizeBytes} >= 5242880`),
    check("file_upload_progress_valid", sql`${table.progressPercent} BETWEEN 0 AND 100`),
    check(
      "file_upload_import_type_valid",
      sql`${table.importType} IN ('apple-health', 'strong-csv', 'cronometer-csv', 'kaya-export', 'zos-app', 'garmin-dump', 'fit-file')`,
    ),
    check(
      "file_upload_state_valid",
      sql`${table.state} IN ('initiated', 'uploading', 'uploaded', 'queued', 'processing', 'completed', 'failed', 'aborted', 'expired')`,
    ),
    check("file_upload_expected_sha256_valid", sql`${table.expectedSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "file_upload_verified_sha256_valid",
      sql`${table.verifiedSha256} IS NULL OR ${table.verifiedSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "file_upload_weight_unit_valid",
      sql`${table.weightUnit} IS NULL OR ${table.weightUnit} IN ('kg', 'lbs')`,
    ),
  ],
);

export const fileUploadOutbox = fitness.table(
  "file_upload_outbox",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => fileUpload.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => [
    unique("file_upload_outbox_upload_id_key").on(table.uploadId),
    unique("file_upload_outbox_import_job_id_key").on(table.importJobId),
    index("file_upload_outbox_dispatch_idx").on(table.status, table.createdAt),
    check(
      "file_upload_outbox_status_valid",
      sql`${table.status} IN ('pending', 'dispatched', 'completed', 'failed')`,
    ),
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
// Subjective body state — explicit user check-ins and injuries
// ============================================================

export const bodyRegion = fitness.table(
  "body_region",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("body_region_parent_sort_idx").on(table.parentId, table.sortOrder, table.id),
    check("body_region_id_nonempty", sql`btrim(${table.id}) <> ''`),
    check("body_region_label_nonempty", sql`btrim(${table.label}) <> ''`),
    check(
      "body_region_kind_valid",
      sql`${table.kind} IN ('body', 'limb', 'hand', 'digit', 'pulley')`,
    ),
  ],
);

export const subjectiveCheckIn = fitness.table(
  "subjective_check_in",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("subjective_check_in_user_date_key").on(table.userId, table.date),
    index("subjective_check_in_user_date_idx").on(table.userId, table.date.desc()),
  ],
);

export const subjectiveSymptom = fitness.table(
  "subjective_symptom",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkInId: uuid("check_in_id")
      .notNull()
      .references(() => subjectiveCheckIn.id, { onDelete: "cascade" }),
    bodyRegionId: text("body_region_id")
      .notNull()
      .references(() => bodyRegion.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    score: integer("score").notNull(),
  },
  (table) => [
    unique("subjective_symptom_unique_kind").on(table.checkInId, table.bodyRegionId, table.kind),
    index("subjective_symptom_region_idx").on(table.bodyRegionId),
    check(
      "subjective_symptom_kind_valid",
      sql`${table.kind} IN ('soreness', 'stiffness', 'tenderness')`,
    ),
    check("subjective_symptom_score_range", sql`${table.score} BETWEEN 1 AND 10`),
  ],
);

export const injuryEvent = fitness.table(
  "injury_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    bodyRegionId: text("body_region_id")
      .notNull()
      .references(() => bodyRegion.id, { onDelete: "restrict" }),
    onsetDate: date("onset_date").notNull(),
    resolvedDate: date("resolved_date"),
    severity: integer("severity").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("injury_event_user_onset_idx").on(table.userId, table.onsetDate.desc()),
    check("injury_event_kind_valid", sql`${table.kind} IN ('injury', 'niggle')`),
    check("injury_event_severity_range", sql`${table.severity} BETWEEN 0 AND 10`),
    check("injury_event_description_nonempty", sql`btrim(${table.description}) <> ''`),
    check(
      "injury_event_resolution_order",
      sql`${table.resolvedDate} IS NULL OR ${table.resolvedDate} >= ${table.onsetDate}`,
    ),
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
    personalExperimentId: uuid("personal_experiment_id").references(() => personalExperiment.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("life_events_started_at_idx").on(table.startedAt)],
);

// ============================================================
// Personal experiments (N-of-1 setup & schedule)
// ============================================================

export const personalExperiment = fitness.table(
  "personal_experiment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id, { onDelete: "cascade" }),
    hypothesis: text("hypothesis").notNull(),
    intervention: text("intervention").notNull(),
    outcomeMetricId: text("outcome_metric_id").notNull(),
    lagDays: bigint("lag_days", { mode: "number" }).notNull().default(0),
    baselineDays: bigint("baseline_days", { mode: "number" }).notNull(),
    interventionDays: bigint("intervention_days", { mode: "number" }).notNull(),
    startDate: date("start_date").notNull(),
    status: text("status").notNull().default("active"),
    stoppedAt: date("stopped_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("personal_experiment_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("personal_experiment_user_status_idx").on(table.userId, table.status),
    check("personal_experiment_hypothesis_nonempty", sql`btrim(${table.hypothesis}) <> ''`),
    check("personal_experiment_intervention_nonempty", sql`btrim(${table.intervention}) <> ''`),
    check(
      "personal_experiment_outcome_metric_nonempty",
      sql`btrim(${table.outcomeMetricId}) <> ''`,
    ),
    check("personal_experiment_lag_days_range", sql`${table.lagDays} BETWEEN 0 AND 7`),
    check("personal_experiment_baseline_days_positive", sql`${table.baselineDays} > 0`),
    check("personal_experiment_intervention_days_positive", sql`${table.interventionDays} > 0`),
    check("personal_experiment_status_valid", sql`${table.status} IN ('active', 'stopped')`),
    check(
      "personal_experiment_stopped_at_consistent",
      sql`(${table.status} = 'active' AND ${table.stoppedAt} IS NULL) OR (${table.status} = 'stopped' AND ${table.stoppedAt} IS NOT NULL)`,
    ),
  ],
);

export const personalExperimentCheckIn = fitness.table(
  "personal_experiment_check_in",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personalExperimentId: uuid("personal_experiment_id")
      .notNull()
      .references(() => personalExperiment.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    adherence: text("adherence").notNull(),
    confounder: text("confounder"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("personal_experiment_check_in_experiment_date_unique").on(
      table.personalExperimentId,
      table.date,
    ),
    check(
      "personal_experiment_check_in_adherence_valid",
      sql`${table.adherence} IN ('adherent', 'partial', 'not_adherent', 'unknown')`,
    ),
    check(
      "personal_experiment_check_in_confounder_nonempty",
      sql`${table.confounder} IS NULL OR btrim(${table.confounder}) <> ''`,
    ),
    check(
      "personal_experiment_check_in_note_nonempty",
      sql`${table.note} IS NULL OR btrim(${table.note}) <> ''`,
    ),
  ],
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
    stressBefore: bigint("stress_before", { mode: "number" }),
    stressAfter: bigint("stress_after", { mode: "number" }),
    dizzinessAfter: boolean("dizziness_after"),
    perceivedEffect: text("perceived_effect"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("breathwork_session_user_idx").on(table.userId),
    index("breathwork_session_started_at_idx").on(table.startedAt.desc()),
    check(
      "breathwork_session_stress_before_range",
      sql`${table.stressBefore} IS NULL OR ${table.stressBefore} BETWEEN 0 AND 10`,
    ),
    check(
      "breathwork_session_stress_after_range",
      sql`${table.stressAfter} IS NULL OR ${table.stressAfter} BETWEEN 0 AND 10`,
    ),
    check(
      "breathwork_session_perceived_effect_valid",
      sql`${table.perceivedEffect} IS NULL OR ${table.perceivedEffect} IN ('better', 'same', 'worse')`,
    ),
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
    // Legacy provider-estimated fields retained temporarily for deployment compatibility.
    restingMetabolicRateKcal: real("resting_metabolic_rate_kcal"),
    restingMetabolicRateRaw: jsonb("resting_metabolic_rate_raw"),
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
