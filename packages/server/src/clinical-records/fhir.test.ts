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
    fhirVersion: "4.0.1",
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
      deriveClinicalRecordDates("labResult", "4.0.1", {
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
      deriveClinicalRecordDates("immunization", "4.0.1", {
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
    expect(
      deriveClinicalRecordDates("medication", "4.0.1", { resourceType, ...dateFields }),
    ).toEqual({
      recordedAt: new Date("2026-04-02T12:00:00.000Z"),
      issuedAt: null,
    });
  });

  it.each([
    [
      "allergy onset",
      "allergy",
      { resourceType: "AllergyIntolerance", onsetDateTime: "2026-05-01T08:00:00Z" },
      "2026-05-01T08:00:00.000Z",
    ],
    [
      "coverage period",
      "coverage",
      { resourceType: "Coverage", period: { start: "2026-01-01T00:00:00Z" } },
      "2026-01-01T00:00:00.000Z",
    ],
    [
      "medication dosage period",
      "medication",
      {
        resourceType: "MedicationRequest",
        dosageInstruction: [
          { timing: { repeat: { boundsPeriod: { start: "2026-04-02T12:00:00Z" } } } },
        ],
      },
      "2026-04-02T12:00:00.000Z",
    ],
    [
      "procedure period",
      "procedure",
      { resourceType: "Procedure", performedPeriod: { start: "2026-06-01T09:00:00Z" } },
      "2026-06-01T09:00:00.000Z",
    ],
    [
      "clinical note context period",
      "clinicalNote",
      { resourceType: "DocumentReference", context: { period: { start: "2026-07-01T10:00:00Z" } } },
      "2026-07-01T10:00:00.000Z",
    ],
  ] as const)("derives the timestamp from %s", (_description, clinicalType, fhir, expected) => {
    expect(deriveClinicalRecordDates(clinicalType, "4.0.1", fhir)).toEqual({
      recordedAt: new Date(expected),
      issuedAt: null,
    });
  });

  it.each([
    "2026",
    "2026-08",
    "2026-08-25",
    "2026-02-30T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-08-25T08:30Z",
    "2026-08-25T08:30:00",
    "2026-08-25T08:30:00+14:01",
    "not-a-date",
  ])("does not invent an instant from partial or invalid FHIR date %s", (recordedDate) => {
    expect(
      deriveClinicalRecordDates("condition", "4.0.1", {
        resourceType: "Condition",
        recordedDate,
      }),
    ).toEqual({ recordedAt: null, issuedAt: null });
  });

  it.each([
    [
      "1.0.2",
      "condition",
      {
        resourceType: "Condition",
        dateRecorded: "2016-01-02T12:00:00Z",
        recordedDate: "2026-01-02T12:00:00Z",
      },
      "2016-01-02T12:00:00.000Z",
    ],
    [
      "4.0.1",
      "condition",
      {
        resourceType: "Condition",
        dateRecorded: "2016-01-02T12:00:00Z",
        recordedDate: "2026-01-02T12:00:00Z",
      },
      "2026-01-02T12:00:00.000Z",
    ],
    [
      "1.0.2",
      "immunization",
      {
        resourceType: "Immunization",
        date: "2016-03-04T12:00:00Z",
        occurrenceDateTime: "2026-03-04T12:00:00Z",
      },
      "2016-03-04T12:00:00.000Z",
    ],
    [
      "4.0.1",
      "immunization",
      {
        resourceType: "Immunization",
        date: "2016-03-04T12:00:00Z",
        occurrenceDateTime: "2026-03-04T12:00:00Z",
      },
      "2026-03-04T12:00:00.000Z",
    ],
  ] as const)(
    "uses %s release fields for %s records",
    (fhirVersion, clinicalType, fhir, expectedRecordedAt) => {
      expect(deriveClinicalRecordDates(clinicalType, fhirVersion, fhir).recordedAt).toEqual(
        new Date(expectedRecordedAt),
      );
    },
  );
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

  it("formats the clinical instant in the user's timezone", () => {
    const summary = summarizeClinicalRecord(
      {
        id: "44444444-4444-4444-8444-444444444444",
        clinicalType: "condition",
        displayName: "Timezone boundary",
        sourceName: "Example Health",
        downloadedAt: new Date(DOWNLOADED_AT),
        recordedAt: new Date("2026-08-25T00:30:00+02:00"),
        issuedAt: null,
      },
      "America/Los_Angeles",
    );

    expect(summary).toMatchObject({
      date: "2026-08-24T22:30:00.000Z",
      dateLabel: "Recorded Aug 24, 2026",
    });
  });
});
