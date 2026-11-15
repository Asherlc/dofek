import { describe, expect, it } from "vitest";
import { cyclingThresholdEvidenceSchema } from "./cycling-threshold.ts";

const evidence = {
  value: 250,
  unit: "watt",
  method: "configured",
  effective_from: "2026-06-15",
  source_record_id: "00000000-0000-4000-8000-000000000001",
  unavailable_reason: null,
};
describe("cycling threshold evidence contract", () => {
  it("accepts configured and explicitly unavailable FTP", () => {
    expect(cyclingThresholdEvidenceSchema.parse(evidence).value).toBe(250);
    expect(
      cyclingThresholdEvidenceSchema.parse({
        ...evidence,
        value: null,
        source_record_id: null,
        effective_from: null,
        unavailable_reason: "No configured FTP",
      }).value,
    ).toBeNull();
  });
  it.each([
    { value: null, unavailable_reason: null },
    { value: 250, unavailable_reason: "No configured FTP" },
    { value: 0, unavailable_reason: null },
  ])("rejects inconsistent threshold availability %j", (values) => {
    expect(cyclingThresholdEvidenceSchema.safeParse({ ...evidence, ...values }).success).toBe(
      false,
    );
  });
});
