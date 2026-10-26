import { describe, expect, it } from "vitest";
import { buildClimbingStrengths, type ClimbingStrengthsObservation } from "./climbing-strengths.ts";

const observation = (
  patch: Partial<ClimbingStrengthsObservation> = {},
): ClimbingStrengthsObservation => ({
  identity: "climb",
  contextKey: "boulder",
  contextLabel: "Bouldering · V scale",
  setting: "indoor",
  grade: "V4",
  gradeSortValue: 4,
  wallAngle: null,
  holdType: null,
  outcome: "not_sent",
  example: {
    logEntryId: "log",
    activityId: null,
    name: "Problem",
    grade: "V4",
    date: "2026-10-20",
    providerId: "kaya",
    sourceName: "KAYA",
    sourceUrl: null,
    outcome: "not_sent",
  },
  ...patch,
});
describe("climbing strengths", () => {
  it("counts each identified climb once and a send overrides repeated failures", () => {
    const result = buildClimbingStrengths([
      observation(),
      observation(),
      observation({ outcome: "sent" }),
      observation({ identity: "other" }),
    ]);
    expect(result.panels.find((p) => p.dimension === "setting")?.grades[0]).toMatchObject({
      climbs: 2,
      sends: 1,
      successRate: 50,
    });
  });
  it("excludes unknown-only outcomes and missing identity or grade visibly", () => {
    const result = buildClimbingStrengths([
      observation({ outcome: null }),
      observation({ identity: null }),
      observation({ identity: "ungraded", grade: null }),
    ]);
    expect(result.coverage).toEqual({ unknownOutcomes: 1, missingIdentity: 1, missingGrades: 1 });
  });
  it("keeps settings separate, unknown units missing, and zero/no-data/limited distinct", () => {
    const result = buildClimbingStrengths([
      observation({ wallAngle: { value: 20, unit: null } }),
      observation({
        identity: "out",
        setting: "outdoor",
        grade: "V5",
        gradeSortValue: 5,
        holdType: "crimp",
      }),
    ]);
    const indoor = result.panels.find(
      (p) => p.dimension === "wall_angle" && p.setting === "indoor",
    );
    expect(indoor?.coverage.missingTraits).toBe(1);
    const settings = result.panels.find((p) => p.dimension === "setting");
    expect(settings?.rows[0]?.cells[0]).toMatchObject({ successRate: 0, sampleStatus: "limited" });
    expect(settings?.rows[0]?.cells[1]).toMatchObject({
      successRate: null,
      sampleStatus: "no_data",
    });
    expect(
      result.panels.find((p) => p.dimension === "hold_type" && p.setting === "outdoor")?.rows[0]
        ?.label,
    ).toBe("Crimp");
  });
  it("marks five climbs available, computes same-grade differences and caps examples", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      observation({
        identity: `climb-${index}`,
        outcome: index < 2 ? "sent" : "not_sent",
        holdType: "crimp",
        wallAngle: { value: 0, unit: "degrees" },
      }),
    );
    const result = buildClimbingStrengths([
      ...entries,
      observation({ identity: "sloper", holdType: "sloper", outcome: "sent" }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.grades[0]).toMatchObject({ successRate: 50, climbs: 6 });
    expect(panel?.rows.find((row) => row.key === "crimp")?.cells[0]).toMatchObject({
      sampleStatus: "available",
      successRate: 40,
      differencePercentagePoints: -10,
    });
    expect(panel?.rows.find((row) => row.key === "crimp")?.cells[0]?.examples).toHaveLength(3);
  });
  it("keeps distinct climbs and semantic contexts independent and unknown does not erase known failure", () => {
    const result = buildClimbingStrengths([
      observation(),
      observation({ outcome: null }),
      observation({ contextKey: "pitch", contextLabel: "Pitch", outcome: "sent" }),
      observation({ identity: "other", grade: "V5", gradeSortValue: 5, outcome: "sent" }),
    ]);
    const panel = result.panels.find(
      (panel) => panel.dimension === "setting" && panel.contextKey === "boulder",
    );
    expect(panel?.grades).toMatchObject([
      { grade: "V4", sends: 0, climbs: 1 },
      { grade: "V5", sends: 1, climbs: 1 },
    ]);
    expect(result.coverage.unknownOutcomes).toBe(0);
    expect(result.panels.some((panel) => panel.contextKey === "pitch")).toBe(true);
  });
  it("merges known setting and traits across observations without duplicating the climb", () => {
    const result = buildClimbingStrengths([
      observation({ setting: null, outcome: "sent" }),
      observation({ holdType: "crimp", wallAngle: { value: 20, unit: "degrees" } }),
    ]);
    expect(result.panels.find((panel) => panel.dimension === "setting")?.grades[0]?.climbs).toBe(1);
    expect(
      result.panels.find((panel) => panel.dimension === "hold_type")?.rows[0]?.cells[0],
    ).toMatchObject({ sends: 1, climbs: 1 });
    expect(result.panels.find((panel) => panel.dimension === "wall_angle")?.rows[0]?.key).toBe(
      "20°",
    );
  });
  it("leaves conflicting recorded traits unknown", () => {
    const result = buildClimbingStrengths([
      observation({
        outcome: "sent",
        holdType: "crimp",
        wallAngle: { value: 20, unit: "degrees" },
      }),
      observation({ holdType: "jug", wallAngle: { value: 30, unit: "degrees" } }),
    ]);
    expect(
      result.panels.find((panel) => panel.dimension === "wall_angle")?.coverage.missingTraits,
    ).toBe(1);
    expect(
      result.panels.find((panel) => panel.dimension === "hold_type")?.coverage.missingTraits,
    ).toBe(1);
  });
  it("excludes conflicting recognized grades for one identity with visible record coverage", () => {
    const result = buildClimbingStrengths([
      observation(),
      observation({ grade: "V5", gradeSortValue: 5, outcome: "sent" }),
    ]);
    expect(result.coverage.missingGrades).toBe(2);
    expect(result.panels).toEqual([]);
  });
  it("uses a unique recognized grade from another observation without losing a send", () => {
    const result = buildClimbingStrengths([
      observation({ grade: null, outcome: "sent" }),
      observation(),
    ]);
    expect(result.coverage.missingGrades).toBe(0);
    expect(result.panels.find((panel) => panel.dimension === "setting")?.grades[0]).toMatchObject({
      grade: "V4",
      sends: 1,
      climbs: 1,
    });
  });
});
