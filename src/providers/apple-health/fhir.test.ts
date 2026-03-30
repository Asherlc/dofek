import { describe, expect, it } from "vitest";
import {
  buildPanelMap,
  extractCodeBySystem,
  type FhirAllergyIntolerance,
  type FhirCondition,
  type FhirDiagnosticReport,
  type FhirMedicationRequest,
  type FhirObservation,
  fhirResourceSchema,
  parseFhirAllergyIntolerance,
  parseFhirCondition,
  parseFhirDiagnosticReport,
  parseFhirMedicationRequest,
  parseFhirObservation,
} from "./fhir.ts";

// ============================================================
// Sample FHIR resources (based on real export data)
// ============================================================

const numericObservation: FhirObservation = {
  resourceType: "Observation",
  id: "obs-bun-001",
  status: "final",
  category: {
    coding: [{ system: "http://hl7.org/fhir/observation-category", code: "laboratory" }],
  },
  code: {
    text: "UREA NITROGEN (BUN)",
    coding: [{ system: "http://loinc.org", display: "UREA NITROGEN (BUN)", code: "3094-0" }],
  },
  valueQuantity: { value: 11.0, unit: "mg/dL" },
  referenceRange: [
    {
      low: { value: 7.0, unit: "mg/dL" },
      high: { value: 25.0, unit: "mg/dL" },
    },
  ],
  effectiveDateTime: "2023-02-27T00:00:00-05:00",
  issued: "2023-03-14T00:25:56-04:00",
};

const textObservation: FhirObservation = {
  resourceType: "Observation",
  id: "obs-nitrite-001",
  status: "final",
  category: [
    {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          code: "laboratory",
        },
      ],
    },
  ],
  code: {
    text: "Nitrite, UA",
    coding: [{ system: "http://loinc.org", code: "5802-4" }],
  },
  valueString: "NEGATIVE",
  referenceRange: [{ text: "NEGATIVE" }],
  effectiveDateTime: "2009-09-29T22:35:00Z",
  issued: "2009-09-30T01:36:09Z",
};

const cholesterolObservation: FhirObservation = {
  resourceType: "Observation",
  id: "obs-chol-001",
  status: "final",
  category: {
    coding: [{ system: "http://hl7.org/fhir/observation-category", code: "laboratory" }],
  },
  code: {
    text: "NON HDL CHOLESTEROL",
    coding: [{ system: "http://loinc.org", display: "NON HDL CHOLESTEROL", code: "43396-1" }],
  },
  valueQuantity: { value: 145.0, unit: "mg/dL (calc)" },
  referenceRange: [{ text: "<130" }],
  effectiveDateTime: "2023-02-27T00:00:00-05:00",
};

const diagnosticReport: FhirDiagnosticReport = {
  resourceType: "DiagnosticReport",
  id: "dr-lipid-001",
  status: "final",
  code: {
    coding: [{ display: "Lipid Panel", system: "http://loinc.org", code: "57698-3" }],
  },
  effectiveDateTime: "2023-02-27T00:00:00-05:00",
  result: [{ reference: "Observation/obs-chol-001" }, { reference: "Observation/obs-ldl-001" }],
};

// ============================================================
// Tests
// ============================================================

describe("FHIR Lab Result Parsing", () => {
  describe("parseFhirObservation", () => {
    it("parses numeric observation with structured reference range", () => {
      const result = parseFhirObservation(numericObservation, "Quest Diagnostics");

      expect(result.testName).toBe("UREA NITROGEN (BUN)");
      expect(result.loincCode).toBe("3094-0");
      expect(result.value).toBe(11.0);
      expect(result.valueText).toBeUndefined();
      expect(result.unit).toBe("mg/dL");
      expect(result.referenceRangeLow).toBe(7.0);
      expect(result.referenceRangeHigh).toBe(25.0);
      expect(result.recordedAt).toEqual(new Date("2023-02-27T00:00:00-05:00"));
      expect(result.issuedAt).toEqual(new Date("2023-03-14T00:25:56-04:00"));
      expect(result.status).toBe("final");
      expect(result.sourceName).toBe("Quest Diagnostics");
    });

    it("parses text-valued observation", () => {
      const result = parseFhirObservation(textObservation, "Sutter Health");

      expect(result.testName).toBe("Nitrite, UA");
      expect(result.loincCode).toBe("5802-4");
      expect(result.value).toBeUndefined();
      expect(result.valueText).toBe("NEGATIVE");
      expect(result.referenceRangeText).toBe("NEGATIVE");
    });

    it("parses text-only reference range", () => {
      const result = parseFhirObservation(cholesterolObservation, "Quest");

      expect(result.value).toBe(145.0);
      expect(result.referenceRangeLow).toBeUndefined();
      expect(result.referenceRangeHigh).toBeUndefined();
      expect(result.referenceRangeText).toBe("<130");
    });

    it("handles observation with no reference range", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-no-ref",
        referenceRange: undefined,
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.referenceRangeLow).toBeUndefined();
      expect(result.referenceRangeHigh).toBeUndefined();
      expect(result.referenceRangeText).toBeUndefined();
    });

    it("uses FHIR id as externalId", () => {
      const result = parseFhirObservation(numericObservation, "Test");
      expect(result.externalId).toBe("obs-bun-001");
    });

    it("handles R4 category array format", () => {
      const result = parseFhirObservation(textObservation, "Test");
      // Should not crash on array category format
      expect(result.testName).toBe("Nitrite, UA");
    });

    it("handles missing LOINC code", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-no-loinc",
        code: { text: "Custom Test", coding: [{ system: "urn:local", code: "123" }] },
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.loincCode).toBeUndefined();
      expect(result.testName).toBe("Custom Test");
    });

    it("falls back to coding display when text is missing", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-display-fallback",
        code: { coding: [{ display: "BUN Test", system: "http://loinc.org", code: "3094-0" }] },
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.testName).toBe("BUN Test");
    });

    it("falls back to coding code when text and display are missing", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-code-fallback",
        code: { coding: [{ system: "http://loinc.org", code: "3094-0" }] },
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.testName).toBe("3094-0");
    });

    it("returns Unknown when code has no text, display, or coding", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-unknown-name",
        code: {},
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.testName).toBe("Unknown");
    });

    it("sets valueText but not value for text-only observations", () => {
      const result = parseFhirObservation(textObservation, "Test");
      expect(result.value).toBeUndefined();
      expect(result.unit).toBeUndefined();
      expect(result.valueText).toBe("NEGATIVE");
    });

    it("does not set referenceRangeText when only low is present", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-range-low-only",
        referenceRange: [{ low: { value: 7.0 }, text: ">=7" }],
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.referenceRangeLow).toBe(7.0);
      expect(result.referenceRangeText).toBeUndefined();
    });

    it("does not set referenceRangeText when only high is present", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-range-high-only",
        referenceRange: [{ high: { value: 25.0 }, text: "<=25" }],
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.referenceRangeHigh).toBe(25.0);
      expect(result.referenceRangeText).toBeUndefined();
    });

    it("prefers valueQuantity over valueString when both present", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-both-values",
        valueQuantity: { value: 95, unit: "mg/dL" },
        valueString: "95 mg/dL",
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.value).toBe(95);
      expect(result.unit).toBe("mg/dL");
      expect(result.valueText).toBeUndefined(); // valueString ignored when valueQuantity present
    });

    it("preserves raw FHIR resource in result", () => {
      const result = parseFhirObservation(numericObservation, "Test");
      expect(result.raw).toMatchObject({
        resourceType: "Observation",
        id: "obs-bun-001",
        valueQuantity: { value: 11.0 },
      });
    });

    it("does not set referenceRangeText when structured range exists", () => {
      const obs: FhirObservation = {
        ...numericObservation,
        id: "obs-range-both",
        referenceRange: [
          {
            low: { value: 7.0, unit: "mg/dL" },
            high: { value: 25.0, unit: "mg/dL" },
            text: "7-25",
          },
        ],
      };
      const result = parseFhirObservation(obs, "Test");
      expect(result.referenceRangeLow).toBe(7.0);
      expect(result.referenceRangeHigh).toBe(25.0);
      // Text should NOT be set when structured low/high exist
      expect(result.referenceRangeText).toBeUndefined();
    });
  });

  describe("parseFhirDiagnosticReport", () => {
    it("parses a DiagnosticReport into a ParsedLabPanel", () => {
      const result = parseFhirDiagnosticReport(diagnosticReport, "Quest Diagnostics");

      expect(result.externalId).toBe("dr-lipid-001");
      expect(result.name).toBe("Lipid Panel");
      expect(result.loincCode).toBe("57698-3");
      expect(result.status).toBe("final");
      expect(result.sourceName).toBe("Quest Diagnostics");
      expect(result.recordedAt).toEqual(new Date("2023-02-27T00:00:00-05:00"));
      expect(result.issuedAt).toBeUndefined();
      expect(result.observationIds).toEqual(["obs-chol-001", "obs-ldl-001"]);
      expect(result.raw).toMatchObject({ resourceType: "DiagnosticReport", id: "dr-lipid-001" });
    });

    it("strips Observation/ prefix from result references", () => {
      const report: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-strip-test",
        code: { text: "Panel" },
        effectiveDateTime: "2023-01-01T00:00:00Z",
        result: [
          { reference: "Observation/abc-123" },
          { reference: "def-456" }, // no prefix
        ],
      };
      const result = parseFhirDiagnosticReport(report, "Test");
      expect(result.observationIds).toEqual(["abc-123", "def-456"]);
    });

    it("handles report with no result array", () => {
      const report: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-empty",
        status: "final",
        code: { text: "Empty Panel" },
        effectiveDateTime: "2023-01-01T00:00:00Z",
      };
      const result = parseFhirDiagnosticReport(report, "Test");
      expect(result.observationIds).toEqual([]);
      expect(result.name).toBe("Empty Panel");
    });

    it("falls back to issued when effectiveDateTime is missing", () => {
      const report: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-issued-only",
        code: { text: "Panel" },
        issued: "2023-06-15T10:00:00Z",
        result: [{ reference: "Observation/obs-1" }],
      };
      const result = parseFhirDiagnosticReport(report, "Test");
      expect(result.recordedAt).toEqual(new Date("2023-06-15T10:00:00Z"));
      expect(result.issuedAt).toEqual(new Date("2023-06-15T10:00:00Z"));
    });

    it("throws when both effectiveDateTime and issued are missing", () => {
      const report: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-no-date",
        code: { text: "Panel" },
      };
      expect(() => parseFhirDiagnosticReport(report, "Test")).toThrow(
        "FHIR DiagnosticReport dr-no-date missing both effectiveDateTime and issued",
      );
    });

    it("handles missing LOINC code", () => {
      const report: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-no-loinc",
        code: { text: "Custom Panel", coding: [{ system: "urn:local", code: "999" }] },
        effectiveDateTime: "2023-01-01T00:00:00Z",
      };
      const result = parseFhirDiagnosticReport(report, "Test");
      expect(result.loincCode).toBeUndefined();
      expect(result.name).toBe("Custom Panel");
    });

    it("handles unknown status gracefully", () => {
      const report: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-unknown-status",
        status: "entered-in-error",
        code: { text: "Panel" },
        effectiveDateTime: "2023-01-01T00:00:00Z",
      };
      const result = parseFhirDiagnosticReport(report, "Test");
      expect(result.status).toBeUndefined();
    });
  });

  describe("extractCodeBySystem", () => {
    it("finds code by system URL", () => {
      const concept = {
        coding: [
          { system: "http://snomed.info/sct", code: "48694002", display: "Anxiety" },
          { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "F41.9" },
        ],
      };
      expect(extractCodeBySystem(concept, "http://snomed.info/sct")).toBe("48694002");
      expect(extractCodeBySystem(concept, "http://hl7.org/fhir/sid/icd-10-cm")).toBe("F41.9");
    });

    it("returns undefined when system not found", () => {
      const concept = { coding: [{ system: "http://loinc.org", code: "123" }] };
      expect(extractCodeBySystem(concept, "http://snomed.info/sct")).toBeUndefined();
    });

    it("returns undefined when coding is empty", () => {
      expect(extractCodeBySystem({}, "http://loinc.org")).toBeUndefined();
    });
  });

  describe("buildPanelMap", () => {
    it("maps observation IDs to panel names", () => {
      const reports = [diagnosticReport];
      const panelMap = buildPanelMap(reports);

      expect(panelMap.get("obs-chol-001")).toBe("Lipid Panel");
      expect(panelMap.get("obs-ldl-001")).toBe("Lipid Panel");
    });

    it("returns empty map for no reports", () => {
      const panelMap = buildPanelMap([]);
      expect(panelMap.size).toBe(0);
    });

    it("uses code text when display is missing", () => {
      const report: FhirDiagnosticReport = {
        ...diagnosticReport,
        code: { coding: [{ system: "http://loinc.org", code: "57698-3" }], text: "Lipid Profile" },
        result: [{ reference: "Observation/obs-123" }],
      };
      const panelMap = buildPanelMap([report]);
      expect(panelMap.get("obs-123")).toBe("Lipid Profile");
    });

    it("only strips Observation/ prefix, not mid-string occurrences", () => {
      const report: FhirDiagnosticReport = {
        ...diagnosticReport,
        result: [{ reference: "Observation/obs-1" }, { reference: "SomeObservation/obs-2" }],
      };
      const panelMap = buildPanelMap([report]);
      // "Observation/" prefix stripped, but "SomeObservation/" kept intact
      expect(panelMap.get("obs-1")).toBe("Lipid Panel");
      expect(panelMap.get("SomeObservation/obs-2")).toBe("Lipid Panel");
    });

    it("handles multiple reports", () => {
      const cbc: FhirDiagnosticReport = {
        resourceType: "DiagnosticReport",
        id: "dr-cbc",
        status: "final",
        code: { coding: [{ display: "CBC", system: "http://loinc.org", code: "58410-2" }] },
        result: [{ reference: "Observation/obs-wbc" }, { reference: "Observation/obs-rbc" }],
      };
      const panelMap = buildPanelMap([diagnosticReport, cbc]);

      expect(panelMap.get("obs-chol-001")).toBe("Lipid Panel");
      expect(panelMap.get("obs-wbc")).toBe("CBC");
      expect(panelMap.get("obs-rbc")).toBe("CBC");
    });
  });
});

// ============================================================
// MedicationRequest fixtures (based on real export data)
// ============================================================

const medicationRequestFull: FhirMedicationRequest = {
  resourceType: "MedicationRequest",
  id: "med-cephalexin-001",
  status: "stopped",
  intent: "order",
  authoredOn: "2011-07-19",
  medicationReference: { display: "Cephalexin 500 mg Cap" },
  contained: [
    {
      resourceType: "Medication",
      id: "med-contained-001",
      code: {
        text: "Cephalexin 500 mg Cap",
        coding: [
          { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "2231" },
          { system: "http://www.whocc.no/atc", code: "J01DB01" },
        ],
      },
      form: { text: "Capsule" },
    },
  ],
  dosageInstruction: [
    {
      text: "Take 1 capsule orally 2 times a day, Disp-100, R-1, Fill Now",
      patientInstruction: "Take 1 capsule orally 2 times a day",
      route: { text: "Oral" },
      timing: {
        repeat: {
          boundsPeriod: { start: "2011-07-19", end: "2011-09-04" },
        },
      },
    },
  ],
  requester: { display: "DAVID GREGORY MOSKOWITZ MD" },
  reasonCode: [
    {
      text: "ACNE",
      coding: [
        { system: "http://snomed.info/sct", display: "Acne (disorder)", code: "11381005" },
        {
          system: "http://hl7.org/fhir/sid/icd-10-cm",
          display: "ACNE, UNSPECIFIED",
          code: "L70.9",
        },
      ],
    },
  ],
};

const medicationRequestMinimal: FhirMedicationRequest = {
  resourceType: "MedicationRequest",
  id: "med-lorazepam-001",
  status: "stopped",
  authoredOn: "2025-09-29",
  medicationReference: { display: "LORazepam 0.5mg Tab" },
  contained: [
    {
      resourceType: "Medication",
      code: {
        text: "LORazepam 0.5mg Tab",
        coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "6470" }],
      },
      form: { text: "Tab" },
    },
  ],
  dosageInstruction: [{ text: "Patient reported" }],
  // requester has data-absent-reason instead of display
  requester: {},
  recorder: { display: "Azja A" },
};

// ============================================================
// Condition fixtures
// ============================================================

const conditionResolved: FhirCondition = {
  resourceType: "Condition",
  id: "cond-anxiety-001",
  code: {
    text: "Anxiety",
    coding: [
      {
        system: "http://hl7.org/fhir/sid/icd-10-cm",
        display: "Anxiety disorder, unspecified",
        code: "F41.9",
      },
      { system: "http://snomed.info/sct", display: "Anxiety", code: "48694002" },
    ],
  },
  clinicalStatus: {
    text: "Resolved",
    coding: [
      { code: "resolved", system: "http://terminology.hl7.org/CodeSystem/condition-clinical" },
    ],
  },
  verificationStatus: {
    text: "Confirmed",
    coding: [
      { code: "confirmed", system: "http://terminology.hl7.org/CodeSystem/condition-ver-status" },
    ],
  },
  onsetDateTime: "2023-06-02",
  abatementDateTime: "2024-06-27",
  recordedDate: "2023-06-02",
};

const conditionMinimal: FhirCondition = {
  resourceType: "Condition",
  id: "cond-minimal-001",
  code: { text: "Back pain" },
};

// ============================================================
// AllergyIntolerance fixtures
// ============================================================

const allergyWithReaction: FhirAllergyIntolerance = {
  resourceType: "AllergyIntolerance",
  id: "allergy-lactase-001",
  code: {
    text: "LACTASE",
    coding: [
      { system: "http://www.nlm.nih.gov/research/umls/rxnorm", display: "LACTASE", code: "41397" },
    ],
  },
  type: "allergy",
  clinicalStatus: {
    coding: [
      {
        code: "active",
        system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
      },
    ],
  },
  verificationStatus: {
    coding: [{ code: "confirmed" }],
  },
  onsetDateTime: "2023-03-27",
  reaction: [
    {
      manifestation: [{ text: "Other (See Comments)" }],
      description: "Other (See Comments)",
    },
  ],
};

const allergyMinimal: FhirAllergyIntolerance = {
  resourceType: "AllergyIntolerance",
  id: "allergy-minimal-001",
};

// ============================================================
// MedicationRequest tests
// ============================================================

describe("FHIR MedicationRequest Parsing", () => {
  describe("parseFhirMedicationRequest", () => {
    it("parses full medication request with all fields", () => {
      const result = parseFhirMedicationRequest(medicationRequestFull, "UCSF Health");

      expect(result.externalId).toBe("med-cephalexin-001");
      expect(result.name).toBe("Cephalexin 500 mg Cap");
      expect(result.status).toBe("stopped");
      expect(result.authoredOn).toBe("2011-07-19");
      expect(result.startDate).toBe("2011-07-19");
      expect(result.endDate).toBe("2011-09-04");
      expect(result.dosageText).toBe("Take 1 capsule orally 2 times a day");
      expect(result.route).toBe("Oral");
      expect(result.form).toBe("Capsule");
      expect(result.rxnormCode).toBe("2231");
      expect(result.prescriberName).toBe("DAVID GREGORY MOSKOWITZ MD");
      expect(result.reasonText).toBe("ACNE");
      expect(result.reasonSnomedCode).toBe("11381005");
      expect(result.sourceName).toBe("UCSF Health");
    });

    it("falls back to contained medication name when medicationReference.display is missing", () => {
      const resource: FhirMedicationRequest = {
        ...medicationRequestFull,
        id: "med-no-ref-display",
        medicationReference: {},
      };
      const result = parseFhirMedicationRequest(resource, "Test");
      expect(result.name).toBe("Cephalexin 500 mg Cap");
    });

    it("falls back to recorder when requester has no display", () => {
      const result = parseFhirMedicationRequest(medicationRequestMinimal, "Test");
      expect(result.prescriberName).toBe("Azja A");
    });

    it("handles missing dosage instruction", () => {
      const resource: FhirMedicationRequest = {
        resourceType: "MedicationRequest",
        id: "med-no-dosage",
        medicationReference: { display: "Some Med" },
      };
      const result = parseFhirMedicationRequest(resource, "Test");
      expect(result.dosageText).toBeUndefined();
      expect(result.route).toBeUndefined();
      expect(result.startDate).toBeUndefined();
      expect(result.endDate).toBeUndefined();
    });

    it("handles missing reason code", () => {
      const result = parseFhirMedicationRequest(medicationRequestMinimal, "Test");
      expect(result.reasonText).toBeUndefined();
      expect(result.reasonSnomedCode).toBeUndefined();
    });

    it("returns Unknown Medication when no name sources exist", () => {
      const resource: FhirMedicationRequest = {
        resourceType: "MedicationRequest",
        id: "med-no-name",
      };
      const result = parseFhirMedicationRequest(resource, "Test");
      expect(result.name).toBe("Unknown Medication");
    });

    it("extracts form from contained medication", () => {
      const result = parseFhirMedicationRequest(medicationRequestFull, "Test");
      expect(result.form).toBe("Capsule");
    });

    it("returns undefined form when no contained medication", () => {
      const resource: FhirMedicationRequest = {
        resourceType: "MedicationRequest",
        id: "med-no-contained",
        medicationReference: { display: "Some Med" },
      };
      const result = parseFhirMedicationRequest(resource, "Test");
      expect(result.form).toBeUndefined();
      expect(result.rxnormCode).toBeUndefined();
    });

    it("handles contained medication with no code property", () => {
      const resource: FhirMedicationRequest = {
        resourceType: "MedicationRequest",
        id: "med-no-code",
        medicationReference: {},
        contained: [{ resourceType: "Medication" }],
      };
      const result = parseFhirMedicationRequest(resource, "Test");
      expect(result.name).toBe("Unknown Medication");
      expect(result.rxnormCode).toBeUndefined();
    });

    it("handles dosage with timing but no boundsPeriod", () => {
      const resource: FhirMedicationRequest = {
        resourceType: "MedicationRequest",
        id: "med-no-bounds",
        medicationReference: { display: "Med" },
        dosageInstruction: [{ text: "Take daily", timing: { repeat: {} } }],
      };
      const result = parseFhirMedicationRequest(resource, "Test");
      expect(result.dosageText).toBe("Take daily");
      expect(result.startDate).toBeUndefined();
      expect(result.endDate).toBeUndefined();
    });

    it("extracts bounds period start and end dates", () => {
      const result = parseFhirMedicationRequest(medicationRequestFull, "Test");
      expect(result.startDate).toBe("2011-07-19");
      expect(result.endDate).toBe("2011-09-04");
    });

    it("prefers patientInstruction over text for dosage", () => {
      const result = parseFhirMedicationRequest(medicationRequestFull, "Test");
      // patientInstruction is "Take 1 capsule orally 2 times a day"
      // text is "Take 1 capsule orally 2 times a day, Disp-100, R-1, Fill Now"
      expect(result.dosageText).toBe("Take 1 capsule orally 2 times a day");
    });

    it("stores raw FHIR resource", () => {
      const result = parseFhirMedicationRequest(medicationRequestFull, "Test");
      expect(result.raw).toMatchObject({
        resourceType: "MedicationRequest",
        id: "med-cephalexin-001",
      });
    });
  });
});

// ============================================================
// Condition tests
// ============================================================

describe("FHIR Condition Parsing", () => {
  describe("parseFhirCondition", () => {
    it("parses condition with all fields", () => {
      const result = parseFhirCondition(conditionResolved, "UCSF Health");

      expect(result.externalId).toBe("cond-anxiety-001");
      expect(result.name).toBe("Anxiety");
      expect(result.clinicalStatus).toBe("resolved");
      expect(result.verificationStatus).toBe("confirmed");
      expect(result.icd10Code).toBe("F41.9");
      expect(result.snomedCode).toBe("48694002");
      expect(result.onsetDate).toBe("2023-06-02");
      expect(result.abatementDate).toBe("2024-06-27");
      expect(result.recordedDate).toBe("2023-06-02");
      expect(result.sourceName).toBe("UCSF Health");
    });

    it("returns undefined status when coding array is empty and no text", () => {
      const resource: FhirCondition = {
        resourceType: "Condition",
        id: "cond-empty-coding",
        code: { text: "Test" },
        clinicalStatus: { coding: [] },
      };
      const result = parseFhirCondition(resource, "Test");
      expect(result.clinicalStatus).toBeUndefined();
    });

    it("falls back to text for clinical status when coding is missing", () => {
      const resource: FhirCondition = {
        resourceType: "Condition",
        id: "cond-text-status",
        code: { text: "Headache" },
        clinicalStatus: { text: "Active" },
      };
      const result = parseFhirCondition(resource, "Test");
      expect(result.clinicalStatus).toBe("active");
    });

    it("handles minimal condition with only name", () => {
      const result = parseFhirCondition(conditionMinimal, "Test");

      expect(result.name).toBe("Back pain");
      expect(result.clinicalStatus).toBeUndefined();
      expect(result.verificationStatus).toBeUndefined();
      expect(result.icd10Code).toBeUndefined();
      expect(result.snomedCode).toBeUndefined();
      expect(result.onsetDate).toBeUndefined();
      expect(result.abatementDate).toBeUndefined();
    });

    it("stores raw FHIR resource", () => {
      const result = parseFhirCondition(conditionResolved, "Test");
      expect(result.raw).toMatchObject({ resourceType: "Condition", id: "cond-anxiety-001" });
    });
  });
});

// ============================================================
// AllergyIntolerance tests
// ============================================================

describe("FHIR AllergyIntolerance Parsing", () => {
  describe("parseFhirAllergyIntolerance", () => {
    it("parses allergy with reactions", () => {
      const result = parseFhirAllergyIntolerance(allergyWithReaction, "UCSF Health");

      expect(result.externalId).toBe("allergy-lactase-001");
      expect(result.name).toBe("LACTASE");
      expect(result.type).toBe("allergy");
      expect(result.clinicalStatus).toBe("active");
      expect(result.verificationStatus).toBe("confirmed");
      expect(result.rxnormCode).toBe("41397");
      expect(result.onsetDate).toBe("2023-03-27");
      expect(result.reactions).toEqual([
        { manifestation: "Other (See Comments)", description: "Other (See Comments)" },
      ]);
      expect(result.sourceName).toBe("UCSF Health");
    });

    it("uses first manifestation text from multiple manifestations", () => {
      const resource: FhirAllergyIntolerance = {
        resourceType: "AllergyIntolerance",
        id: "allergy-multi-manifest",
        code: { text: "Peanut" },
        reaction: [
          {
            manifestation: [{ text: "Hives" }, { text: "Swelling" }],
            description: "Allergic reaction",
          },
        ],
      };
      const result = parseFhirAllergyIntolerance(resource, "Test");
      // Should pick first manifestation only
      expect(result.reactions[0]?.manifestation).toBe("Hives");
    });

    it("handles allergy with empty manifestation array", () => {
      const resource: FhirAllergyIntolerance = {
        resourceType: "AllergyIntolerance",
        id: "allergy-empty-manifest",
        code: { text: "Dust" },
        reaction: [{ manifestation: [] }],
      };
      const result = parseFhirAllergyIntolerance(resource, "Test");
      expect(result.reactions[0]?.manifestation).toBeUndefined();
    });

    it("handles allergy with reaction that has no manifestation text", () => {
      const resource: FhirAllergyIntolerance = {
        resourceType: "AllergyIntolerance",
        id: "allergy-no-manifest",
        code: { text: "Penicillin" },
        reaction: [{ description: "Hives" }],
      };
      const result = parseFhirAllergyIntolerance(resource, "Test");
      expect(result.reactions).toEqual([{ manifestation: undefined, description: "Hives" }]);
    });

    it("handles minimal allergy with no code", () => {
      const result = parseFhirAllergyIntolerance(allergyMinimal, "Test");

      expect(result.name).toBe("Unknown Allergen");
      expect(result.type).toBeUndefined();
      expect(result.clinicalStatus).toBeUndefined();
      expect(result.rxnormCode).toBeUndefined();
      expect(result.reactions).toEqual([]);
    });

    it("stores raw FHIR resource", () => {
      const result = parseFhirAllergyIntolerance(allergyWithReaction, "Test");
      expect(result.raw).toMatchObject({
        resourceType: "AllergyIntolerance",
        id: "allergy-lactase-001",
      });
    });
  });
});

// ============================================================
// fhirResourceSchema discriminated union
// ============================================================

describe("fhirResourceSchema", () => {
  it("parses MedicationRequest", () => {
    const result = fhirResourceSchema.safeParse(medicationRequestFull);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceType).toBe("MedicationRequest");
    }
  });

  it("parses Condition", () => {
    const result = fhirResourceSchema.safeParse(conditionResolved);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceType).toBe("Condition");
    }
  });

  it("parses AllergyIntolerance", () => {
    const result = fhirResourceSchema.safeParse(allergyWithReaction);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceType).toBe("AllergyIntolerance");
    }
  });

  it("rejects unknown resource types", () => {
    const result = fhirResourceSchema.safeParse({ resourceType: "DocumentReference", id: "doc-1" });
    expect(result.success).toBe(false);
  });
});
