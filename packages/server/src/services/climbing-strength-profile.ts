import type { ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";

type Counts = { grade: string; sends: number; climbs: number; unknownOutcomes: number };
/** Compare observed sends with expected sends using each style's known-result grade mix. */
export function buildClimbingStrengthProfile(profile: {
  grades: Counts[];
  rows: Array<{ key: string; cells: Counts[] }>;
}): ClimbingStrengthsPanel["gradeAdjustedStrengths"] {
  const baselines = new Map(profile.grades.map((grade) => [grade.grade, grade]));
  return profile.rows.map((row) => {
    let known = 0;
    let sends = 0;
    let expected = 0;
    for (const cell of row.cells) {
      const count = cell.climbs - cell.unknownOutcomes;
      if (count === 0) continue;
      const baseline = baselines.get(cell.grade);
      if (!baseline || baseline.climbs === baseline.unknownOutcomes)
        throw new Error(`Missing known-result baseline for climbing grade ${cell.grade}`);
      known += count;
      sends += cell.sends;
      expected += (count * baseline.sends) / (baseline.climbs - baseline.unknownOutcomes);
    }
    return {
      key: row.key,
      expectedSuccessRate: known === 0 ? null : Math.round((expected / known) * 1000) / 10,
      differencePercentagePoints:
        known === 0 ? null : Math.round(((sends - expected) / known) * 1000) / 10,
      sampleStatus: known === 0 ? "no_data" : known < 5 ? "limited" : "available",
    };
  });
}
