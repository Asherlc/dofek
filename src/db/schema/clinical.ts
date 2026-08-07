import { date, index, jsonb, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { labResultStatusEnum } from "./enums.ts";
import { provider, userProfile } from "./reference.ts";

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
    panelId: uuid("panel_id").references(() => labPanel.id, { onDelete: "cascade" }),
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
