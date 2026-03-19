import { z } from "zod";

// ============================================================
// FHIR Clinical Records -- Lab Results
// ============================================================

const fhirCodingSchema = z.object({
  system: z.string().optional(),
  code: z.string().optional(),
  display: z.string().optional(),
});

const fhirCodeableConceptSchema = z.object({
  text: z.string().optional(),
  coding: z.array(fhirCodingSchema).optional(),
});

const fhirQuantitySchema = z.object({
  value: z.number().optional(),
  unit: z.string().optional(),
  system: z.string().optional(),
  code: z.string().optional(),
});

const fhirReferenceRangeSchema = z.object({
  low: fhirQuantitySchema.optional(),
  high: fhirQuantitySchema.optional(),
  text: z.string().optional(),
});

const fhirObservationSchema = z.object({
  resourceType: z.literal("Observation"),
  id: z.string(),
  status: z.string().optional(),
  category: z.union([fhirCodeableConceptSchema, z.array(fhirCodeableConceptSchema)]).optional(),
  code: fhirCodeableConceptSchema,
  valueQuantity: fhirQuantitySchema.optional(),
  valueString: z.string().optional(),
  referenceRange: z.array(fhirReferenceRangeSchema).optional(),
  effectiveDateTime: z.string().optional(),
  issued: z.string().optional(),
});

const fhirDiagnosticReportSchema = z.object({
  resourceType: z.literal("DiagnosticReport"),
  id: z.string(),
  status: z.string().optional(),
  code: fhirCodeableConceptSchema,
  effectiveDateTime: z.string().optional(),
  issued: z.string().optional(),
  result: z.array(z.object({ reference: z.string() })).optional(),
});

export const fhirResourceSchema = z.discriminatedUnion("resourceType", [
  fhirObservationSchema,
  fhirDiagnosticReportSchema,
]);

export type FhirCodeableConcept = z.infer<typeof fhirCodeableConceptSchema>;
export type FhirObservation = z.infer<typeof fhirObservationSchema>;
export type FhirDiagnosticReport = z.infer<typeof fhirDiagnosticReportSchema>;

export const VALID_LAB_STATUSES: ReadonlyArray<string> = [
  "final",
  "preliminary",
  "corrected",
  "cancelled",
];
type LabResultStatus = "final" | "preliminary" | "corrected" | "cancelled";

function isLabResultStatus(s: string): s is LabResultStatus {
  return VALID_LAB_STATUSES.includes(s);
}

export interface ParsedLabResult {
  externalId: string;
  testName: string;
  loincCode?: string;
  value?: number;
  valueText?: string;
  unit?: string;
  referenceRangeLow?: number;
  referenceRangeHigh?: number;
  referenceRangeText?: string;
  status?: LabResultStatus;
  sourceName: string;
  recordedAt: Date;
  issuedAt?: Date;
  raw: Record<string, unknown>;
}

/**
 * Extract the LOINC code from a FHIR CodeableConcept's coding array.
 */
function extractLoincCode(concept: FhirCodeableConcept): string | undefined {
  return concept.coding?.find((c) => c.system === "http://loinc.org")?.code;
}

/**
 * Get display name from a CodeableConcept -- prefer text, then coding display.
 */
function getDisplayName(concept: FhirCodeableConcept): string {
  if (concept.text) return concept.text;
  for (const coding of concept.coding ?? []) {
    if (coding.display) return coding.display;
  }
  return concept.coding?.[0]?.code ?? "Unknown";
}

/**
 * Parse a FHIR Observation into a ParsedLabResult.
 */
export function parseFhirObservation(obs: FhirObservation, sourceName: string): ParsedLabResult {
  const result: ParsedLabResult = {
    externalId: obs.id,
    testName: getDisplayName(obs.code),
    loincCode: extractLoincCode(obs.code),
    status: obs.status && isLabResultStatus(obs.status) ? obs.status : undefined,
    sourceName,
    recordedAt: (() => {
      const dateStr = obs.effectiveDateTime ?? obs.issued;
      if (!dateStr)
        throw new Error(`FHIR Observation ${obs.id} missing both effectiveDateTime and issued`);
      return new Date(dateStr);
    })(),
    issuedAt: obs.issued ? new Date(obs.issued) : undefined,
    raw: { ...obs },
  };

  // Value: numeric or text
  if (obs.valueQuantity?.value != null) {
    result.value = obs.valueQuantity.value;
    result.unit = obs.valueQuantity.unit;
  } else if (obs.valueString) {
    result.valueText = obs.valueString;
  }

  // Reference range
  const range = obs.referenceRange?.[0];
  if (range) {
    if (range.low?.value != null) result.referenceRangeLow = range.low.value;
    if (range.high?.value != null) result.referenceRangeHigh = range.high.value;
    if (range.text && !range.low && !range.high) result.referenceRangeText = range.text;
  }

  return result;
}

/**
 * Build a map from Observation FHIR ID -> panel name, using DiagnosticReports.
 */
export function buildPanelMap(reports: FhirDiagnosticReport[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const report of reports) {
    const panelName = getDisplayName(report.code);
    for (const ref of report.result ?? []) {
      // reference format: "Observation/obs-id-here"
      const obsId = ref.reference.replace(/^Observation\//, "");
      map.set(obsId, panelName);
    }
  }
  return map;
}
