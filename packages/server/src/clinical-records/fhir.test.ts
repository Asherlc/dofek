import { describe, expect, it } from "vitest";
import {
  clinicalRecordInputSchema,
  deriveClinicalRecordDates,
  summarizeClinicalRecord,
} from "./fhir.ts";

const DOWNLOADED_AT = "2026-08-28T18:00:00.000Z";

function record(clinicalType: string, fhir: Record<string, unknown>): Record<string, unknown> {
  return {
    externalId: "11111111-1111-4111-8111-111111111111",
    clinicalType,
    displayName: "Wellness panel",
    sourceName: "Example Health",
    fhirVersion: "R4",
    fhir,
    downloadedAt: DOWNLOADED_AT,
  };
}

describe("clinicalRecordInputSchema", () => {
  it.each([
    ["allergy", "AllergyIntolerance"],
    ["condition", "Condition"],
    ["coverage", "Coverage"],
    ["immunization", "Immunization"],
    ["labResult", "DiagnosticReport"],
    ["labResult", "Observation"],
    ["medication", "MedicationRequest"],
    ["medication", "MedicationOrder"],
    ["medication", "MedicationDispense"],
    ["medication", "MedicationStatement"],
    ["procedure", "Procedure"],
    ["vitalSign", "Observation"],
    ["clinicalNote", "DocumentReference"],
  ])("accepts %s records backed by %s FHIR", (clinicalType, resourceType) => {
    expect(
      clinicalRecordInputSchema.safeParse(record(clinicalType, { resourceType })).success,
    ).toBe(true);
  });

  it("rejects FHIR whose resource type conflicts with its HealthKit type", () => {
    const result = clinicalRecordInputSchema.safeParse(
      record("condition", { resourceType: "Observation" }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({ path: ["fhir", "resourceType"] });
  });

  it("rejects a FHIR object without a resource type", () => {
    const result = clinicalRecordInputSchema.safeParse(record("condition", { id: "condition-1" }));

    expect(result.success).toBe(false);
  });
});

describe("deriveClinicalRecordDates", () => {
  it("uses the faithful clinical and issued timestamps for a lab observation", () => {
    expect(
      deriveClinicalRecordDates("labResult", {
        resourceType: "Observation",
        effectiveDateTime: "2026-08-25T08:30:00-07:00",
        issued: "2026-08-25T16:00:00Z",
      }),
    ).toEqual({
      recordedAt: new Date("2026-08-25T15:30:00.000Z"),
      issuedAt: new Date("2026-08-25T16:00:00.000Z"),
    });
  });

  it("uses FHIR dates appropriate to non-observation clinical resources", () => {
    expect(
      deriveClinicalRecordDates("immunization", {
        resourceType: "Immunization",
        occurrenceDateTime: "2026-04-02T12:00:00Z",
        recorded: "2026-04-03T12:00:00Z",
      }),
    ).toEqual({
      recordedAt: new Date("2026-04-02T12:00:00.000Z"),
      issuedAt: new Date("2026-04-03T12:00:00.000Z"),
    });
  });

  it.each([
    ["MedicationRequest", { authoredOn: "2026-04-02T12:00:00Z" }],
    ["MedicationOrder", { dateWritten: "2026-04-02T12:00:00Z" }],
    ["MedicationDispense", { whenHandedOver: "2026-04-02T12:00:00Z" }],
    ["MedicationStatement", { effectiveDateTime: "2026-04-02T12:00:00Z" }],
  ])("derives medication dates from %s FHIR", (resourceType, dateFields) => {
    expect(deriveClinicalRecordDates("medication", { resourceType, ...dateFields })).toEqual({
      recordedAt: new Date("2026-04-02T12:00:00.000Z"),
      issuedAt: null,
    });
  });

  it("does not invent timestamps from malformed FHIR dates", () => {
    expect(
      deriveClinicalRecordDates("condition", {
        resourceType: "Condition",
        recordedDate: "not-a-date",
      }),
    ).toEqual({ recordedAt: null, issuedAt: null });
  });
});

describe("summarizeClinicalRecord", () => {
  it("authors stable type, source, and recorded-date labels on the server", () => {
    expect(
      summarizeClinicalRecord(
        {
          id: "22222222-2222-4222-8222-222222222222",
          clinicalType: "labResult",
          displayName: "Wellness panel",
          sourceName: "Example Health",
          downloadedAt: new Date(DOWNLOADED_AT),
          recordedAt: new Date("2026-08-25T15:30:00.000Z"),
          issuedAt: new Date("2026-08-25T16:00:00.000Z"),
        },
        "America/Los_Angeles",
      ),
    ).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      clinicalType: "labResult",
      typeLabel: "Lab Result",
      displayName: "Wellness panel",
      sourceName: "Example Health",
      sourceLabel: "Example Health",
      date: "2026-08-25T15:30:00.000Z",
      dateLabel: "Recorded Aug 25, 2026",
      downloadedAt: DOWNLOADED_AT,
      recordedAt: "2026-08-25T15:30:00.000Z",
      issuedAt: "2026-08-25T16:00:00.000Z",
    });
  });

  it("falls back to a neutral source and the HealthKit download date", () => {
    const summary = summarizeClinicalRecord(
      {
        id: "33333333-3333-4333-8333-333333333333",
        clinicalType: "clinicalNote",
        displayName: "Visit note",
        sourceName: null,
        downloadedAt: new Date(DOWNLOADED_AT),
        recordedAt: null,
        issuedAt: null,
      },
      "UTC",
    );

    expect(summary).toMatchObject({
      typeLabel: "Clinical Note",
      sourceLabel: "Unknown source",
      date: DOWNLOADED_AT,
      dateLabel: "Downloaded Aug 28, 2026",
    });
  });
});
