import { describe, expect, it } from "vitest";
import { type PmcActivityRow, PmcTrainingLoadCalculator } from "./pmc-training-load-calculator.ts";

function makeActivityRow(overrides: Partial<PmcActivityRow> = {}): PmcActivityRow {
  return {
    id: "activity-1",
    date: "2026-05-20",
    ...overrides,
  };
}

function makeCalculator(): PmcTrainingLoadCalculator {
  return new PmcTrainingLoadCalculator();
}

describe("PmcTrainingLoadCalculator", () => {
  it("uses each activity's canonical stress without requiring heart rate", () => {
    const calculator = makeCalculator();
    const result = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "one" }), makeActivityRow({ id: "two" })],
      powerTssByActivity: new Map([
        ["one", 80],
        ["two", 25],
      ]),
    });
    expect(result.get("2026-05-20")).toBe(105);
  });
  it("keeps missing power and missing heart rate unavailable", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow({ avg_hr: null })],
      powerTssByActivity: new Map(),
    });
    expect(result.size).toBe(0);
  });
  it("retains recorded zero power stress", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow()],
      powerTssByActivity: new Map([["activity-1", 0]]),
    });
    expect(result.get("2026-05-20")).toBe(0);
  });
});
