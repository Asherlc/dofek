import { index, jsonb, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { fitness, resolveImplicitUserId } from "./core.ts";
import { provider, userProfile } from "./reference.ts";

// ============================================================
// Canonical FHIR clinical records
// ============================================================

export const clinicalRecord = fitness.table(
  "clinical_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => userProfile.id),
    providerId: text("provider_id")
      .notNull()
      .references(() => provider.id),
    externalId: text("external_id").notNull(),
    clinicalType: text("clinical_type").notNull(),
    displayName: text("display_name").notNull(),
    sourceName: text("source_name"),
    fhirVersion: text("fhir_version").notNull(),
    fhir: jsonb("fhir").notNull(),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("clinical_record_user_provider_external_idx").on(
      table.userId,
      table.providerId,
      table.externalId,
    ),
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
    sourceBundle: text("source_bundle"),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>(),
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
