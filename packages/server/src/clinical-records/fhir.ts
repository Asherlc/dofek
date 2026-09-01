import { z } from "zod";

export const CLINICAL_TYPE_IDS = [
  "allergy",
  "condition",
  "coverage",
  "immunization",
  "labResult",
  "medication",
  "procedure",
  "vitalSign",
  "clinicalNote",
] as const;

export type ClinicalType = (typeof CLINICAL_TYPE_IDS)[number];

export const fhirObjectSchema = z.record(z.string(), z.unknown());
const fhirInstantSchema = z
  .string()
  .regex(
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/,
  )
  .pipe(z.iso.datetime({ offset: true }));

type FhirRelease = "dstu2" | "r4" | "unknown";

const compatibleResourceTypes: Readonly<Record<ClinicalType, readonly string[]>> = {
  allergy: ["AllergyIntolerance"],
  condition: ["Condition"],
  coverage: ["Coverage"],
  immunization: ["Immunization"],
  labResult: ["DiagnosticReport", "Observation"],
  medication: ["MedicationRequest", "MedicationOrder", "MedicationDispense", "MedicationStatement"],
  procedure: ["Procedure"],
  vitalSign: ["Observation"],
  clinicalNote: ["DocumentReference"],
};

const clinicalTypeLabels: Readonly<Record<ClinicalType, string>> = {
  allergy: "Allergy",
  condition: "Condition",
  coverage: "Coverage",
  immunization: "Immunization",
  labResult: "Lab Result",
  medication: "Medication",
  procedure: "Procedure",
  vitalSign: "Vital Sign",
  clinicalNote: "Clinical Note",
};

export const clinicalRecordInputSchema = z
  .object({
    externalId: z.uuid(),
    clinicalType: z.enum(CLINICAL_TYPE_IDS),
    displayName: z.string().min(1),
    sourceName: z.string().min(1).nullable(),
    fhirVersion: z.string().min(1),
    fhir: fhirObjectSchema,
    downloadedAt: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    const resourceType = record.fhir.resourceType;
    if (
      typeof resourceType !== "string" ||
      !compatibleResourceTypes[record.clinicalType].includes(resourceType)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fhir", "resourceType"],
        message: `FHIR resourceType must match the ${clinicalTypeLabels[record.clinicalType]} clinical type.`,
      });
    }
  });

export type ClinicalRecordInput = z.infer<typeof clinicalRecordInputSchema>;

function objectValue(value: unknown): Record<string, unknown> | null {
  const parsed = fhirObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringAtPath(resource: Record<string, unknown>, ...path: string[]): string | null {
  let value: unknown = resource;
  for (const part of path) {
    const object = objectValue(value);
    if (!object) return null;
    value = object[part];
  }
  return typeof value === "string" ? value : null;
}

function firstArrayObjectAtPath(
  resource: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = resource[key];
  return Array.isArray(value) ? objectValue(value[0]) : null;
}

function fhirRelease(version: string): FhirRelease {
  const normalized = version.trim().toUpperCase();
  if (normalized === "DSTU2" || normalized === "R2" || normalized.startsWith("1.")) {
    return "dstu2";
  }
  if (normalized === "R4" || normalized.startsWith("4.")) return "r4";
  return "unknown";
}

function parseFhirInstant(value: string | null): Date | null {
  const parsed = fhirInstantSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data) : null;
}

function firstFhirInstant(...values: Array<string | null>): Date | null {
  for (const value of values) {
    const instant = parseFhirInstant(value);
    if (instant) return instant;
  }
  return null;
}

export interface ClinicalRecordDates {
  recordedAt: Date | null;
  issuedAt: Date | null;
}

export function deriveClinicalRecordDates(
  clinicalType: ClinicalType,
  fhirVersion: string,
  fhir: Record<string, unknown>,
): ClinicalRecordDates {
  const release = fhirRelease(fhirVersion);
  let recordedAt: Date | null = null;
  let issuedAt: Date | null = null;

  switch (clinicalType) {
    case "allergy":
      recordedAt = firstFhirInstant(
        stringAtPath(fhir, "recordedDate"),
        stringAtPath(fhir, "onsetDateTime"),
      );
      break;
    case "condition":
      recordedAt = firstFhirInstant(
        release === "dstu2"
          ? stringAtPath(fhir, "dateRecorded")
          : release === "r4"
            ? stringAtPath(fhir, "recordedDate")
            : null,
        stringAtPath(fhir, "onsetDateTime"),
      );
      break;
    case "coverage":
      recordedAt = firstFhirInstant(stringAtPath(fhir, "period", "start"));
      break;
    case "immunization":
      recordedAt = firstFhirInstant(
        release === "dstu2"
          ? stringAtPath(fhir, "date")
          : release === "r4"
            ? stringAtPath(fhir, "occurrenceDateTime")
            : null,
      );
      issuedAt = firstFhirInstant(release === "r4" ? stringAtPath(fhir, "recorded") : null);
      break;
    case "labResult":
    case "vitalSign":
      recordedAt = firstFhirInstant(
        stringAtPath(fhir, "effectiveDateTime"),
        stringAtPath(fhir, "effectivePeriod", "start"),
      );
      issuedAt = firstFhirInstant(stringAtPath(fhir, "issued"));
      break;
    case "medication": {
      const dosageInstruction = firstArrayObjectAtPath(fhir, "dosageInstruction");
      recordedAt = firstFhirInstant(
        stringAtPath(fhir, "authoredOn"),
        stringAtPath(fhir, "dateWritten"),
        stringAtPath(fhir, "whenHandedOver"),
        stringAtPath(fhir, "whenPrepared"),
        stringAtPath(fhir, "effectiveDateTime"),
        stringAtPath(fhir, "effectivePeriod", "start"),
        stringAtPath(fhir, "dateAsserted"),
        dosageInstruction
          ? stringAtPath(dosageInstruction, "timing", "repeat", "boundsPeriod", "start")
          : null,
      );
      break;
    }
    case "procedure":
      recordedAt = firstFhirInstant(
        stringAtPath(fhir, "performedDateTime"),
        stringAtPath(fhir, "performedPeriod", "start"),
      );
      break;
    case "clinicalNote":
      recordedAt = firstFhirInstant(
        stringAtPath(fhir, "date"),
        stringAtPath(fhir, "context", "period", "start"),
      );
      break;
  }

  return { recordedAt, issuedAt };
}

export const clinicalRecordSummarySchema = z.object({
  id: z.uuid(),
  clinicalType: z.enum(CLINICAL_TYPE_IDS),
  typeLabel: z.string().min(1),
  displayName: z.string().min(1),
  sourceName: z.string().nullable(),
  sourceLabel: z.string().min(1),
  date: z.iso.datetime(),
  dateLabel: z.string().min(1),
  downloadedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime().nullable(),
  issuedAt: z.iso.datetime().nullable(),
});

export type ClinicalRecordSummary = z.infer<typeof clinicalRecordSummarySchema>;

export const clinicalRecordPageSchema = z.object({
  records: z.array(clinicalRecordSummarySchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const clinicalRecordDetailSchema = clinicalRecordSummarySchema.extend({
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  fhirVersion: z.string().min(1),
  fhir: fhirObjectSchema,
});

export type ClinicalRecordDetail = z.infer<typeof clinicalRecordDetailSchema>;

export interface StoredClinicalRecordSummary {
  id: string;
  clinicalType: string;
  displayName: string;
  sourceName: string | null;
  downloadedAt: Date;
  recordedAt: Date | null;
  issuedAt: Date | null;
}

function formatDisplayDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone,
    year: "numeric",
  }).format(date);
}

export function summarizeClinicalRecord(
  row: StoredClinicalRecordSummary,
  timeZone: string,
): ClinicalRecordSummary {
  const clinicalType = z.enum(CLINICAL_TYPE_IDS).parse(row.clinicalType);
  const displayedDate = row.recordedAt ?? row.issuedAt ?? row.downloadedAt;
  const datePrefix = row.recordedAt ? "Recorded" : row.issuedAt ? "Issued" : "Downloaded";

  return clinicalRecordSummarySchema.parse({
    id: row.id,
    clinicalType,
    typeLabel: clinicalTypeLabels[clinicalType],
    displayName: row.displayName,
    sourceName: row.sourceName,
    sourceLabel: row.sourceName ?? "Unknown source",
    date: displayedDate.toISOString(),
    dateLabel: `${datePrefix} ${formatDisplayDate(displayedDate, timeZone)}`,
    downloadedAt: row.downloadedAt.toISOString(),
    recordedAt: row.recordedAt?.toISOString() ?? null,
    issuedAt: row.issuedAt?.toISOString() ?? null,
  });
}
