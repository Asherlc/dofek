import { describe, expect, it } from "vitest";
import {
  calculationEvidenceSchema,
  epistemicKindSchema,
  qualityEvidenceSchema,
  sourceReferenceSchema,
  unavailableMetricSchema,
} from "./analytical-evidence.ts";

describe("analytical evidence schemas", () => {
  it("accepts every supported epistemic kind", () => {
    expect(
      [
        "measured",
        "provider_recorded",
        "aggregated",
        "calculated",
        "estimated",
        "interpolated",
        "inferred",
        "unknown",
      ].map((kind) => epistemicKindSchema.parse(kind)),
    ).toEqual([
      "measured",
      "provider_recorded",
      "aggregated",
      "calculated",
      "estimated",
      "interpolated",
      "inferred",
      "unknown",
    ]);
  });

  it("keeps source measurement kind narrower than calculated-result evidence", () => {
    const source = {
      provider_id: "wahoo",
      device_id: "Wahoo trainer",
      source_type: "fit",
      source_record_id: "sample-1",
      activity_id: "54c63104-47e7-49f9-aac2-8a20ecfc4910",
      member_activity_id: "29ea5b82-fd05-48e3-bedd-0bd7a4c82573",
      measurement_kind: "direct",
    } as const;

    expect(sourceReferenceSchema.parse(source)).toEqual(source);
    expect(() =>
      sourceReferenceSchema.parse({ ...source, measurement_kind: "calculated" }),
    ).toThrow();
  });

  it("accepts nullable coverage observations without converting them to zero", () => {
    expect(
      qualityEvidenceSchema.parse({
        status: "limited",
        reasons: ["native sampling interval is five seconds"],
        observed_samples: 120,
        expected_samples: null,
        coverage_pct: null,
        largest_gap_seconds: 5,
        timezone_assumption: null,
      }),
    ).toEqual({
      status: "limited",
      reasons: ["native sampling interval is five seconds"],
      observed_samples: 120,
      expected_samples: null,
      coverage_pct: null,
      largest_gap_seconds: 5,
      timezone_assumption: null,
    });
  });

  it("rejects invalid quality percentages and empty explanations", () => {
    expect(() =>
      qualityEvidenceSchema.parse({ status: "high", reasons: [], coverage_pct: 100.1 }),
    ).toThrow();
    expect(() => qualityEvidenceSchema.parse({ status: "unavailable", reasons: [""] })).toThrow();
  });

  it("requires a specific reason when a metric is unavailable", () => {
    expect(unavailableMetricSchema.parse({ value: null, reason: "FTP is unknown" })).toEqual({
      value: null,
      reason: "FTP is unknown",
    });
    expect(() => unavailableMetricSchema.parse({ value: null, reason: "" })).toThrow();
  });

  it("accepts calculation evidence with finite scalar parameters", () => {
    expect(
      calculationEvidenceSchema.parse({
        kind: "calculated",
        method: "power_tss",
        formula: "hours * intensity_factor^2 * 100",
        parameters: { ftp_watts: 250, historical: true, note: null },
        assumptions: ["FTP was effective on the activity date"],
      }),
    ).toMatchObject({ kind: "calculated", method: "power_tss" });
    expect(() =>
      calculationEvidenceSchema.parse({
        kind: "calculated",
        method: "invalid",
        formula: null,
        parameters: { value: Number.POSITIVE_INFINITY },
        assumptions: [],
      }),
    ).toThrow();
  });
});
