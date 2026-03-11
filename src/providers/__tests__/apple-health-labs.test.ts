import { describe, expect, it } from "vitest";
import {
  buildPanelMap,
  type FhirDiagnosticReport,
  type FhirObservation,
  parseFhirObservation,
} from "../apple-health.ts";

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
