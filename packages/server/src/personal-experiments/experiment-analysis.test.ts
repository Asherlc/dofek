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
        {
          date: "2026-08-03",
          adherence: "partial",
          confounder: "Baseline confounder",
          note: "Baseline note",
        },
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
    expect(result.coverage.baseline.adherenceCounts).toEqual({
      adherent: 0,
      partial: 0,
      not_adherent: 0,
      unknown: 0,
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
      confounder: null,
      note: null,
      sourceProviderIds: ["oura", "apple-health"],
    });
    expect(result.uncertainty).toMatchObject({
      availability: "available",
      level: 0.95,
      blockLength: 3,
      attemptedReplicateCount: 9612,
      validReplicateCount: 2_000,
    });
    if (result.uncertainty.availability === "available") {
      expect(result.uncertainty.lower).toBeCloseTo(3.7333333333, 10);
      expect(result.uncertainty.upper).toBeCloseTo(12, 10);
    }
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
    expect(result.coverage.baseline).toMatchObject({
      expectedDayCount: 4,
      observedOutcomeDayCount: 4,
      missingOutcomeDayCount: 0,
      checkInCount: 0,
    });
    expect(result.coverage.intervention).toMatchObject({
      expectedDayCount: 4,
      observedOutcomeDayCount: 4,
      missingOutcomeDayCount: 0,
      checkInCount: 4,
    });
    expect(result.limitations).not.toContain(
      "0 scheduled outcome days are missing from the canonical metric.",
    );
    expect(result.limitations).not.toContain("0 intervention days were marked not adherent.");
    expect(result.limitations).not.toContain("0 intervention days have unknown adherence.");
    expect(result.limitations).not.toContain("0 intervention days have no check-in.");
    expect(result.limitations).not.toContain("0 linked confounders were recorded.");
    expect(result.limitations).not.toContain(
      "One or more outcome days include multiple provider sources.",
    );
  });

  it("requires five adherent or partial intervention outcomes", () => {
    const result = buildExperimentAnalysis({
      lagDays: 0,
      schedule: {
        baselineStartDate: "2026-09-01",
        baselineEndDate: "2026-09-05",
        interventionStartDate: "2026-09-06",
        interventionEndDate: "2026-09-10",
      },
      checkIns: [
        { date: "2026-09-06", adherence: "adherent", confounder: null, note: null },
        { date: "2026-09-07", adherence: "partial", confounder: null, note: null },
        { date: "2026-09-08", adherence: "adherent", confounder: null, note: null },
        { date: "2026-09-09", adherence: "partial", confounder: null, note: null },
        { date: "2026-09-10", adherence: "not_adherent", confounder: null, note: null },
      ],
      outcomes: [
        ...[10, 11, 12, 13, 14].map((value, index) => ({
          date: `2026-09-0${index + 1}`,
          value,
          sourceProviderIds: ["oura"],
        })),
        ...[20, 21, 22, 23].map((value, index) => ({
          date: `2026-09-0${index + 6}`,
          value,
          sourceProviderIds: ["oura"],
        })),
      ],
    });

    expect(result).toMatchObject({
      availability: "insufficient",
      effect: null,
      coverage: {
        baseline: { observedOutcomeDayCount: 5, missingOutcomeDayCount: 0 },
        intervention: { observedOutcomeDayCount: 4, missingOutcomeDayCount: 1 },
      },
      uncertainty: { availability: "unavailable", reason: "insufficient_outcomes" },
    });
    expect(result.limitations).toContain(
      "1 scheduled outcome day is missing from the canonical metric.",
    );
  });

  it("requires five observed baseline outcomes", () => {
    const result = buildExperimentAnalysis({
      lagDays: 0,
      schedule: {
        baselineStartDate: "2026-09-11",
        baselineEndDate: "2026-09-15",
        interventionStartDate: "2026-09-16",
        interventionEndDate: "2026-09-20",
      },
      checkIns: [
        { date: "2026-09-16", adherence: "adherent", confounder: null, note: null },
        { date: "2026-09-17", adherence: "partial", confounder: null, note: null },
        { date: "2026-09-18", adherence: "adherent", confounder: null, note: null },
        { date: "2026-09-19", adherence: "partial", confounder: null, note: null },
        { date: "2026-09-20", adherence: "adherent", confounder: null, note: null },
      ],
      outcomes: [
        ...[10, 11, 12, 13].map((value, index) => ({
          date: `2026-09-1${index + 1}`,
          value,
          sourceProviderIds: ["oura"],
        })),
        ...[20, 21, 22, 23, 24].map((value, index) => ({
          date: `2026-09-${index + 16}`,
          value,
          sourceProviderIds: ["oura"],
        })),
      ],
    });

    expect(result).toMatchObject({
      availability: "insufficient",
      effect: null,
      coverage: {
        baseline: { observedOutcomeDayCount: 4, missingOutcomeDayCount: 1 },
        intervention: { observedOutcomeDayCount: 5, missingOutcomeDayCount: 0 },
      },
      uncertainty: { availability: "unavailable", reason: "insufficient_outcomes" },
    });
    expect(result.limitations).toContain(
      "1 scheduled outcome day is missing from the canonical metric.",
    );
  });

  it("reports singular and plural adherence, check-in, and missing-outcome limitations", () => {
    const result = buildExperimentAnalysis({
      lagDays: 0,
      schedule: {
        baselineStartDate: "2026-09-21",
        baselineEndDate: "2026-09-25",
        interventionStartDate: "2026-09-26",
        interventionEndDate: "2026-10-02",
      },
      checkIns: [
        { date: "2026-09-26", adherence: "adherent", confounder: null, note: null },
        { date: "2026-09-27", adherence: "not_adherent", confounder: null, note: null },
        { date: "2026-09-28", adherence: "not_adherent", confounder: null, note: null },
        { date: "2026-09-29", adherence: "unknown", confounder: null, note: null },
        { date: "2026-09-30", adherence: "unknown", confounder: null, note: null },
      ],
      outcomes: [
        ...[10, 11, 12, 13].map((value, index) => ({
          date: `2026-09-2${index + 1}`,
          value,
          sourceProviderIds: [],
        })),
        ...[20, 21, 22, 23, 24].map((value, index) => ({
          date: `2026-09-${index + 26}`,
          value,
          sourceProviderIds: ["oura"],
        })),
        { date: "2026-10-01", value: 25, sourceProviderIds: ["oura"] },
        { date: "2026-10-02", value: 26, sourceProviderIds: ["oura"] },
      ],
    });

    expect(result.limitations).toEqual([
      "This is an observational comparison, not a causal conclusion.",
      "1 scheduled outcome day is missing from the canonical metric.",
      "2 intervention days were marked not adherent.",
      "2 intervention days have unknown adherence.",
      "2 intervention days have no check-in.",
      "At least 5 observed baseline outcomes and 5 adherent or partial intervention outcomes are required.",
    ]);
  });

  it("uses a plural verb when multiple linked confounders are recorded", () => {
    const result = buildExperimentAnalysis({
      lagDays: 0,
      schedule: {
        baselineStartDate: "2026-08-01",
        baselineEndDate: "2026-08-01",
        interventionStartDate: "2026-08-02",
        interventionEndDate: "2026-08-03",
      },
      checkIns: [
        { date: "2026-08-02", adherence: "adherent", confounder: "Travel", note: null },
        { date: "2026-08-03", adherence: "partial", confounder: "Late meal", note: null },
      ],
      outcomes: [],
    });

    expect(result.limitations).toContain("2 linked confounders were recorded.");
    expect(result.observations.map((observation) => observation.sourceProviderIds)).toEqual([
      [],
      [],
      [],
    ]);
    expect(result.limitations).toContain(
      "3 scheduled outcome days are missing from the canonical metric.",
    );
  });
});
