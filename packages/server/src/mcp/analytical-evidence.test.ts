import { describe, expect, it } from "vitest";
import { epistemicKindSchema, sourceReferenceSchema } from "./analytical-evidence.ts";

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
});
