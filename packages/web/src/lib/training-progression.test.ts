import { describe, expect, it } from "vitest";
import {
  flatBenchmarkRow,
  repImprovementRow,
  statusRowWithoutBadgeFirst,
  unbadgedRepImprovementRow,
} from "../components/training-progression-fixture.ts";
import {
  firstStatusRow,
  strengthEvidenceSummary,
  strengthHeadline,
} from "./training-progression.ts";

describe("training progression client formatting", () => {
  it("selects the first server-ordered row that has a status", () => {
    expect(firstStatusRow(statusRowWithoutBadgeFirst)?.exerciseId).toBe("bench");
    expect(firstStatusRow([])).toBeUndefined();
    expect(firstStatusRow(undefined)).toBeUndefined();
  });

  it("uses the shared headline for exercises with and without equipment", () => {
    expect(strengthHeadline(repImprovementRow)).toBe("Bench press · Barbell");
    expect(strengthHeadline({ ...repImprovementRow, equipment: null })).toBe("Bench press");
  });

  it("summarizes recorded rep improvement without assigning a status", () => {
    expect(strengthEvidenceSummary(unbadgedRepImprovementRow)).toBe("More reps at the same weight");
    expect(strengthEvidenceSummary(repImprovementRow)).toBe("More reps at the same weight");
  });

  it("summarizes flat benchmark evidence with its observed session count", () => {
    expect(strengthEvidenceSummary(flatBenchmarkRow)).toBe(
      "Estimated strength held steady across 7 comparable sessions.",
    );
  });
});
