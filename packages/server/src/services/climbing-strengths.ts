import type {
  ClimbingStrengths,
  ClimbingStrengthsExample,
  ClimbingStrengthsPanel,
} from "@dofek/training/climbing-strengths";
export interface ClimbingStrengthsObservation {
  identity: string | null;
  contextKey: string;
  contextLabel: string;
  setting: "indoor" | "outdoor" | null;
  grade: string | null;
  gradeSortValue: number;
  wallAngle: { value: number; unit: "degrees" | null } | null;
  holdType: string | null;
  outcome: "sent" | "not_sent" | null;
  example: ClimbingStrengthsExample;
}
const percent = (sends: number, climbs: number) =>
  climbs ? Math.round((sends / climbs) * 100) : null;
function trait(
  entry: ClimbingStrengthsObservation,
  dimension: ClimbingStrengthsPanel["dimension"],
): string | null {
  if (dimension === "setting") return entry.setting;
  if (dimension === "hold_type") return entry.holdType;
  const angle = entry.wallAngle;
  return angle?.unit === "degrees" ? `${angle.value}°` : null;
}
export function buildClimbingStrengths(
  observations: ClimbingStrengthsObservation[],
): ClimbingStrengths {
  const coverage = { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 };
  const groups = new Map<string, ClimbingStrengthsObservation[]>();
  for (const entry of observations) {
    if (entry.identity === null) {
      coverage.missingIdentity++;
      continue;
    }
    const key = JSON.stringify([entry.contextKey, entry.identity]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const entries: ClimbingStrengthsObservation[] = [];
  for (const group of groups.values()) {
    const grades = [
      ...new Map(
        group.flatMap((entry) => (entry.grade === null ? [] : [[entry.grade, entry] as const])),
      ).values(),
    ];
    // Assign one grade only after consolidating the identified climb. Conflicting
    // recognized grades exclude these source observations rather than guessing.
    const grade = grades.length === 1 ? grades[0] : undefined;
    if (!grade) {
      coverage.missingGrades += group.length;
      continue;
    }
    const preferred =
      group.find((e) => e.outcome === "sent") ??
      group.find((e) => e.outcome === "not_sent") ??
      group[0];
    if (!preferred) continue;
    if (preferred.outcome === null) coverage.unknownOutcomes++;
    // Missing facts do not erase known facts; conflicting facts remain unknown.
    const settings = [...new Set(group.flatMap((entry) => entry.setting ?? []))];
    const holds = [...new Set(group.flatMap((entry) => entry.holdType ?? []))];
    const angles = [
      ...new Set(
        group.flatMap((entry) =>
          entry.wallAngle?.unit === "degrees" ? [entry.wallAngle.value] : [],
        ),
      ),
    ];
    entries.push({
      ...preferred,
      grade: grade.grade,
      gradeSortValue: grade.gradeSortValue,
      setting: settings.length === 1 ? (settings[0] ?? null) : null,
      holdType: holds.length === 1 ? (holds[0] ?? null) : null,
      wallAngle:
        angles.length === 1 && angles[0] !== undefined
          ? { value: angles[0], unit: "degrees" }
          : null,
      example: {
        ...preferred.example,
        grade: grade.grade ?? "",
        outcome: preferred.outcome ?? "not_sent",
      },
    });
  }
  const panels: ClimbingStrengthsPanel[] = [];
  const contexts = [...new Set(entries.map((e) => e.contextKey))].sort();
  for (const contextKey of contexts) {
    const context = entries.filter((e) => e.contextKey === contextKey);
    for (const dimension of ["wall_angle", "hold_type", "setting"] as const) {
      const settings =
        dimension === "setting"
          ? [null]
          : (["indoor", "outdoor"] as const).filter((s) => context.some((e) => e.setting === s));
      for (const setting of settings) {
        const selected = context.filter((e) => setting === null || e.setting === setting);
        const known = selected.filter((e) => e.outcome !== null);
        const grades = [
          ...new Map(
            known.map((e) => [e.grade, { grade: e.grade ?? "", gradeSortValue: e.gradeSortValue }]),
          ).values(),
        ]
          .sort((a, b) => a.gradeSortValue - b.gradeSortValue || a.grade.localeCompare(b.grade))
          .map((g) => {
            const matching = known.filter((e) => e.grade === g.grade);
            const sends = matching.filter((e) => e.outcome === "sent").length;
            return {
              ...g,
              sends,
              climbs: matching.length,
              successRate: percent(sends, matching.length),
            };
          });
        const keys =
          dimension === "setting"
            ? ["indoor", "outdoor"]
            : [...new Set(known.flatMap((e) => trait(e, dimension) ?? []))].sort();
        panels.push({
          key: JSON.stringify([contextKey, dimension, setting]),
          contextKey,
          contextLabel: context[0]?.contextLabel ?? contextKey,
          dimension,
          setting,
          grades,
          rows: keys.map((key) => ({
            key,
            label: key.charAt(0).toUpperCase() + key.slice(1),
            cells: grades.map((g) => {
              const matching = known.filter(
                (e) => e.grade === g.grade && trait(e, dimension) === key,
              );
              const sends = matching.filter((e) => e.outcome === "sent").length;
              const successRate = percent(sends, matching.length);
              return {
                grade: g.grade,
                sends,
                climbs: matching.length,
                successRate,
                differencePercentagePoints:
                  successRate === null || g.successRate === null
                    ? null
                    : successRate - g.successRate,
                sampleStatus:
                  matching.length === 0 ? "no_data" : matching.length < 5 ? "limited" : "available",
                examples: matching.slice(0, 3).map((e) => e.example),
              };
            }),
          })),
          coverage: {
            missingTraits: known.filter((e) => trait(e, dimension) === null).length,
            unknownOutcomes: selected.filter((e) => e.outcome === null).length,
          },
        });
      }
    }
  }
  return { panels, coverage };
}
