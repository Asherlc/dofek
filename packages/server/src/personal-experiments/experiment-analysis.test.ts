import { describe, expect, it } from "vitest";
import { buildExperimentAnalysis } from "./experiment-analysis.ts";

describe("buildExperimentAnalysis", () => {
  it("keeps missing days and non-adherent check-ins explicit while estimating the lagged phase difference", () => {
    const result = buildExperimentAnalysis({
      lagDays: 1,
      schedule: {
        baselineStartDate: "2026-08-01",
        baselineEndDate: "2026-08-05",
        interventionStartDate: "2026-08-06",
        interventionEndDate: "2026-08-12",
      },
      checkIns: [
        { date: "2026-08-06", adherence: "adherent", confounder: null, note: null },
        { date: "2026-08-07", adherence: "partial", confounder: "Late flight", note: null },
        { date: "2026-08-08", adherence: "not_adherent", confounder: null, note: "Missed bedtime" },
        { date: "2026-08-09", adherence: "unknown", confounder: null, note: null },
        { date: "2026-08-10", adherence: "adherent", confounder: null, note: null },
        { date: "2026-08-11", adherence: "partial", confounder: null, note: null },
        { date: "2026-08-12", adherence: "adherent", confounder: null, note: null },
      ],
      outcomes: [
        { date: "2026-08-02", value: 10, sourceProviderIds: ["oura"] },
        { date: "2026-08-03", value: 12, sourceProviderIds: ["oura"] },
        { date: "2026-08-04", value: 14, sourceProviderIds: ["oura", "apple-health"] },
        { date: "2026-08-05", value: 16, sourceProviderIds: ["oura"] },
        { date: "2026-08-06", value: 18, sourceProviderIds: ["oura"] },
        { date: "2026-08-07", value: 20, sourceProviderIds: ["oura"] },
        { date: "2026-08-08", value: 21, sourceProviderIds: ["oura"] },
        { date: "2026-08-09", value: 99, sourceProviderIds: ["oura"] },
        { date: "2026-08-10", value: 99, sourceProviderIds: ["oura"] },
        { date: "2026-08-11", value: 22, sourceProviderIds: ["oura"] },
        { date: "2026-08-12", value: 23, sourceProviderIds: ["oura"] },
        { date: "2026-08-13", value: 24, sourceProviderIds: ["oura"] },
      ],
    });

    expect(result).toMatchObject({
      availability: "available",
      effect: {
        baselineMean: 14,
        interventionMean: 22,
        differenceInMeans: 8,
        baselineSampleCount: 5,
        interventionSampleCount: 5,
      },
      coverage: {
        baseline: {
          expectedDayCount: 5,
          observedOutcomeDayCount: 5,
          missingOutcomeDayCount: 0,
        },
        intervention: {
          expectedDayCount: 7,
          observedOutcomeDayCount: 7,
          checkInCount: 7,
          adherenceCounts: { adherent: 3, partial: 2, not_adherent: 1, unknown: 1 },
        },
      },
    });
    expect(
      result.observations.find((observation) => observation.phaseDate === "2026-08-08"),
    ).toMatchObject({
      phase: "intervention",
      phaseDate: "2026-08-08",
      outcomeDate: "2026-08-09",
      value: 99,
      adherence: "not_adherent",
      sourceProviderIds: ["oura"],
    });
    expect(
      result.observations.find((observation) => observation.phaseDate === "2026-08-03"),
    ).toMatchObject({
      phase: "baseline",
      phaseDate: "2026-08-03",
      outcomeDate: "2026-08-04",
      value: 14,
      adherence: null,
      sourceProviderIds: ["oura", "apple-health"],
    });
    expect(result.uncertainty).toMatchObject({ availability: "available", level: 0.95 });
    expect(result.limitations).toContain(
      "This is an observational comparison, not a causal conclusion.",
    );
    expect(result.limitations).toContain("1 intervention day was marked not adherent.");
    expect(result.limitations).toContain("1 intervention day has unknown adherence.");
    expect(result.limitations).toContain("1 linked confounder was recorded.");
    expect(result.limitations).toContain(
      "One or more outcome days include multiple provider sources.",
    );
  });

  it("reports insufficient evidence when either phase has fewer than five included outcomes", () => {
    const result = buildExperimentAnalysis({
      lagDays: 0,
      schedule: {
        baselineStartDate: "2026-08-01",
        baselineEndDate: "2026-08-04",
        interventionStartDate: "2026-08-05",
        interventionEndDate: "2026-08-08",
      },
      checkIns: [
        { date: "2026-08-05", adherence: "adherent", confounder: null, note: null },
        { date: "2026-08-06", adherence: "adherent", confounder: null, note: null },
        { date: "2026-08-07", adherence: "partial", confounder: null, note: null },
        { date: "2026-08-08", adherence: "adherent", confounder: null, note: null },
      ],
      outcomes: [
        { date: "2026-08-01", value: 10, sourceProviderIds: ["oura"] },
        { date: "2026-08-02", value: 12, sourceProviderIds: ["oura"] },
        { date: "2026-08-03", value: 14, sourceProviderIds: ["oura"] },
        { date: "2026-08-04", value: 16, sourceProviderIds: ["oura"] },
        { date: "2026-08-05", value: 20, sourceProviderIds: ["oura"] },
        { date: "2026-08-06", value: 21, sourceProviderIds: ["oura"] },
        { date: "2026-08-07", value: 22, sourceProviderIds: ["oura"] },
        { date: "2026-08-08", value: 23, sourceProviderIds: ["oura"] },
      ],
    });

    expect(result).toMatchObject({
      availability: "insufficient",
      effect: null,
      uncertainty: { availability: "unavailable", reason: "insufficient_outcomes" },
    });
    expect(result.limitations).toContain(
      "At least 5 observed baseline outcomes and 5 adherent or partial intervention outcomes are required.",
    );
  });
});
