import { describe, expect, it } from "vitest";
import {
  formatHealthProvenanceSource,
  formatHealthProvenanceSummary,
} from "./health-provenance.ts";

const provenance = {
  latestDate: "2026-07-30",
  sourceProviders: ["whoop", "apple_health"],
  observedDays: 3,
  windowDays: 30,
};

describe("health provenance formatting", () => {
  it("uses canonical provider labels in the source text", () => {
    expect(formatHealthProvenanceSource(provenance)).toBe("WHOOP (Cloud), Apple Health");
  });

  it("formats the summary with coverage and latest date", () => {
    expect(formatHealthProvenanceSummary(provenance)).toBe(
      "WHOOP (Cloud), Apple Health · 3/30 days · latest 2026-07-30",
    );
  });

  it("reports missing source and latest data explicitly", () => {
    expect(
      formatHealthProvenanceSummary({
        latestDate: null,
        sourceProviders: [],
        observedDays: 0,
        windowDays: 30,
      }),
    ).toBe("Unknown source · 0/30 days · latest unavailable");
  });
});
