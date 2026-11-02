import { describe, expect, it } from "vitest";
import {
  cyclingThresholdEvidenceSchema,
  cyclingThresholdUncertainty,
} from "./cycling-threshold.ts";

const evidence = {
  value: 250,
  unit: "watt",
  method: "computed_eftp",
  event_at: null,
  evidence_activity_id: null,
  evidence_at: null,
  evidence_duration_seconds: null,
  evidence_power: null,
  model_version: "v1",
  unavailable_reason: null,
  uncertainty: cyclingThresholdUncertainty,
};
describe("cycling threshold evidence contract", () => {
  it("accepts supported and explicitly unavailable computed thresholds", () => {
    expect(cyclingThresholdEvidenceSchema.parse(evidence).value).toBe(250);
    expect(
      cyclingThresholdEvidenceSchema.parse({
        ...evidence,
        value: null,
        unavailable_reason: "No qualifying effort",
      }).value,
    ).toBeNull();
  });
  it.each([
    { value: null, unavailable_reason: null },
    { value: 250, unavailable_reason: "No qualifying effort" },
    { value: 0, unavailable_reason: null },
  ])("rejects inconsistent threshold availability %j", (values) => {
    expect(cyclingThresholdEvidenceSchema.safeParse({ ...evidence, ...values }).success).toBe(
      false,
    );
  });
});
