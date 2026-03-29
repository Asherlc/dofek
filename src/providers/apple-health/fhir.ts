import { z } from "zod";

// ============================================================
// FHIR Clinical Records
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

const fhirMedicationSchema = z.object({
  resourceType: z.literal("Medication"),
  id: z.string().optional(),
  code: fhirCodeableConceptSchema.optional(),
  form: fhirCodeableConceptSchema.optional(),
});

const fhirMedicationRequestSchema = z.object({
  resourceType: z.literal("MedicationRequest"),
  id: z.string(),
  status: z.string().optional(),
  intent: z.string().optional(),
  authoredOn: z.string().optional(),
  medicationReference: z
    .object({ display: z.string().optional(), reference: z.string().optional() })
    .optional(),
  contained: z.array(fhirMedicationSchema).optional(),
  dosageInstruction: z
    .array(
      z.object({
        text: z.string().optional(),
        patientInstruction: z.string().optional(),
        route: fhirCodeableConceptSchema.optional(),
        timing: z
          .object({
            repeat: z
              .object({
                boundsPeriod: z
                  .object({ start: z.string().optional(), end: z.string().optional() })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  requester: z.object({ display: z.string().optional() }).passthrough().optional(),
  recorder: z.object({ display: z.string().optional() }).passthrough().optional(),
  reasonCode: z.array(fhirCodeableConceptSchema).optional(),
  courseOfTherapyType: fhirCodeableConceptSchema.optional(),
});

const fhirConditionSchema = z.object({
  resourceType: z.literal("Condition"),
  id: z.string(),
  code: fhirCodeableConceptSchema,
  clinicalStatus: fhirCodeableConceptSchema.optional(),
  verificationStatus: fhirCodeableConceptSchema.optional(),
  onsetDateTime: z.string().optional(),
  abatementDateTime: z.string().optional(),
  recordedDate: z.string().optional(),
});

const fhirReactionSchema = z.object({
  manifestation: z.array(fhirCodeableConceptSchema).optional(),
  description: z.string().optional(),
});

const fhirAllergyIntoleranceSchema = z.object({
  resourceType: z.literal("AllergyIntolerance"),
  id: z.string(),
  code: fhirCodeableConceptSchema.optional(),
  type: z.string().optional(),
  clinicalStatus: fhirCodeableConceptSchema.optional(),
  verificationStatus: fhirCodeableConceptSchema.optional(),
  onsetDateTime: z.string().optional(),
  recordedDate: z.string().optional(),
  reaction: z.array(fhirReactionSchema).optional(),
});

export const fhirResourceSchema = z.discriminatedUnion("resourceType", [
  fhirObservationSchema,
  fhirDiagnosticReportSchema,
  fhirMedicationRequestSchema,
  fhirConditionSchema,
  fhirAllergyIntoleranceSchema,
]);

export type FhirCodeableConcept = z.infer<typeof fhirCodeableConceptSchema>;
export type FhirObservation = z.infer<typeof fhirObservationSchema>;
export type FhirDiagnosticReport = z.infer<typeof fhirDiagnosticReportSchema>;
export type FhirMedicationRequest = z.infer<typeof fhirMedicationRequestSchema>;
export type FhirCondition = z.infer<typeof fhirConditionSchema>;
export type FhirAllergyIntolerance = z.infer<typeof fhirAllergyIntoleranceSchema>;

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

export interface ParsedLabPanel {
  externalId: string;
  name: string;
  loincCode?: string;
  status?: LabResultStatus;
  sourceName: string;
  recordedAt: Date;
  issuedAt?: Date;
  raw: Record<string, unknown>;
  /** FHIR IDs of Observations referenced by this panel */
  observationIds: string[];
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
 * Extract a code from a FHIR CodeableConcept's coding array by system URL.
 */
export function extractCodeBySystem(
  concept: FhirCodeableConcept,
  systemUrl: string,
): string | undefined {
  return concept.coding?.find((c) => c.system === systemUrl)?.code;
}

/**
 * Extract the LOINC code from a FHIR CodeableConcept's coding array.
 */
function extractLoincCode(concept: FhirCodeableConcept): string | undefined {
  return extractCodeBySystem(concept, "http://loinc.org");
}

/**
 * Extract the first status code from a FHIR CodeableConcept (clinicalStatus/verificationStatus).
 */
function extractStatusCode(concept: FhirCodeableConcept | undefined): string | undefined {
  if (!concept) return undefined;
  return concept.coding?.[0]?.code ?? concept.text?.toLowerCase();
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
 * Parse a FHIR DiagnosticReport into a ParsedLabPanel.
 */
export function parseFhirDiagnosticReport(
  report: FhirDiagnosticReport,
  sourceName: string,
): ParsedLabPanel {
  const dateStr = report.effectiveDateTime ?? report.issued;
  if (!dateStr) {
    throw new Error(`FHIR DiagnosticReport ${report.id} missing both effectiveDateTime and issued`);
  }

  return {
    externalId: report.id,
    name: getDisplayName(report.code),
    loincCode: extractLoincCode(report.code),
    status: report.status && isLabResultStatus(report.status) ? report.status : undefined,
    sourceName,
    recordedAt: new Date(dateStr),
    issuedAt: report.issued ? new Date(report.issued) : undefined,
    raw: { ...report },
    observationIds: (report.result ?? []).map((ref) => ref.reference.replace(/^Observation\//, "")),
  };
}

// ============================================================
// FHIR Clinical Records -- Medications, Conditions, Allergies
// ============================================================

export interface ParsedMedication {
  externalId: string;
  name: string;
  status?: string;
  authoredOn?: string;
  startDate?: string;
  endDate?: string;
  dosageText?: string;
  route?: string;
  form?: string;
  rxnormCode?: string;
  prescriberName?: string;
  reasonText?: string;
  reasonSnomedCode?: string;
  sourceName: string;
  raw: Record<string, unknown>;
}

export interface ParsedCondition {
  externalId: string;
  name: string;
  clinicalStatus?: string;
  verificationStatus?: string;
  icd10Code?: string;
  snomedCode?: string;
  onsetDate?: string;
  abatementDate?: string;
  recordedDate?: string;
  sourceName: string;
  raw: Record<string, unknown>;
}

export interface ParsedAllergyIntolerance {
  externalId: string;
  name: string;
  type?: string;
  clinicalStatus?: string;
  verificationStatus?: string;
  rxnormCode?: string;
  onsetDate?: string;
  reactions: Array<{ manifestation?: string; description?: string }>;
  sourceName: string;
  raw: Record<string, unknown>;
}

/**
 * Parse a FHIR MedicationRequest into a ParsedMedication.
 */
export function parseFhirMedicationRequest(
  resource: FhirMedicationRequest,
  sourceName: string,
): ParsedMedication {
  // Medication name: prefer medicationReference.display, fall back to contained Medication
  const containedMed = resource.contained?.[0];
  const name =
    resource.medicationReference?.display ?? containedMed?.code?.text ?? "Unknown Medication";

  // RxNorm code from contained Medication
  const rxnormCode = containedMed?.code
    ? extractCodeBySystem(containedMed.code, "http://www.nlm.nih.gov/research/umls/rxnorm")
    : undefined;

  // Form from contained Medication
  const form = containedMed?.form?.text;

  // Dosage instruction
  const dosage = resource.dosageInstruction?.[0];
  const dosageText = dosage?.patientInstruction ?? dosage?.text;
  const route = dosage?.route?.text;
  const boundsPeriod = dosage?.timing?.repeat?.boundsPeriod;

  // Prescriber: prefer requester, fall back to recorder
  const prescriberName = resource.requester?.display ?? resource.recorder?.display;

  // Reason
  const reasonCode = resource.reasonCode?.[0];
  const reasonText = reasonCode ? getDisplayName(reasonCode) : undefined;
  const reasonSnomedCode = reasonCode
    ? extractCodeBySystem(reasonCode, "http://snomed.info/sct")
    : undefined;

  return {
    externalId: resource.id,
    name,
    status: resource.status,
    authoredOn: resource.authoredOn,
    startDate: boundsPeriod?.start,
    endDate: boundsPeriod?.end,
    dosageText,
    route,
    form,
    rxnormCode,
    prescriberName,
    reasonText,
    reasonSnomedCode,
    sourceName,
    raw: { ...resource },
  };
}

/**
 * Parse a FHIR Condition into a ParsedCondition.
 */
export function parseFhirCondition(resource: FhirCondition, sourceName: string): ParsedCondition {
  return {
    externalId: resource.id,
    name: getDisplayName(resource.code),
    clinicalStatus: extractStatusCode(resource.clinicalStatus),
    verificationStatus: extractStatusCode(resource.verificationStatus),
    icd10Code: extractCodeBySystem(resource.code, "http://hl7.org/fhir/sid/icd-10-cm"),
    snomedCode: extractCodeBySystem(resource.code, "http://snomed.info/sct"),
    onsetDate: resource.onsetDateTime,
    abatementDate: resource.abatementDateTime,
    recordedDate: resource.recordedDate,
    sourceName,
    raw: { ...resource },
  };
}

/**
 * Parse a FHIR AllergyIntolerance into a ParsedAllergyIntolerance.
 */
export function parseFhirAllergyIntolerance(
  resource: FhirAllergyIntolerance,
  sourceName: string,
): ParsedAllergyIntolerance {
  const name = resource.code ? getDisplayName(resource.code) : "Unknown Allergen";

  const rxnormCode = resource.code
    ? extractCodeBySystem(resource.code, "http://www.nlm.nih.gov/research/umls/rxnorm")
    : undefined;

  const reactions = (resource.reaction ?? []).map((reaction) => ({
    manifestation: reaction.manifestation?.[0]?.text,
    description: reaction.description,
  }));

  return {
    externalId: resource.id,
    name,
    type: resource.type,
    clinicalStatus: extractStatusCode(resource.clinicalStatus),
    verificationStatus: extractStatusCode(resource.verificationStatus),
    rxnormCode,
    onsetDate: resource.onsetDateTime,
    reactions,
    sourceName,
    raw: { ...resource },
  };
}

/**
 * Build a map from Observation FHIR ID -> panel name, using DiagnosticReports.
 * @deprecated Use parseFhirDiagnosticReport instead — panels are now stored as first-class rows.
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
