import { formatDateYmdInTimeZone } from "@dofek/format/format";
import type { ClimbingWallAngle } from "@dofek/training/climbing-experience";
import { type FreeRockGradeSystem, gradeSystemLabel } from "@dofek/training/climbing-grades";
import type {
  ClimbingStrengths,
  ClimbingStrengthsExample,
  ClimbingStrengthsPanel,
} from "@dofek/training/climbing-strengths";
import { ALL_CLIMBING_GRADES } from "@dofek/training/climbing-strengths";
import { buildClimbingStrengthProfile } from "./climbing-strength-profile.ts";
export interface ClimbingStrengthsObservation {
  identity: string | null;
  contextKey: string;
  laneKey: string;
  gradeSystem: FreeRockGradeSystem | null;
  contextLabel: string;
  setting: "indoor" | "outdoor" | null;
  grade: string | null;
  gradeSortValue: number;
  wallAngle: ClimbingWallAngle | null;
  holdTypes: string[] | null;
  outcome: "sent" | "not_sent" | null;
  example: ClimbingStrengthsExample;
}
const percent = (sends: number, climbs: number) =>
  climbs ? Math.round((sends / climbs) * 100) : null;
function trait(
  entry: ClimbingStrengthsObservation,
  dimension: ClimbingStrengthsPanel["dimension"],
): string[] {
  if (dimension === "setting") return [entry.setting ?? "unknown"];
  if (dimension === "hold_type") return entry.holdTypes ?? [];
  const angle = entry.wallAngle;
  if (angle && "category" in angle) return [angle.category];
  return angle?.unit === "degrees" ? [`${angle.value}°`] : [];
}
const sampleStatus = (climbs: number): "no_data" | "limited" | "available" =>
  climbs === 0 ? "no_data" : climbs < 5 ? "limited" : "available";
function monthlyWindows(window: { startDate: string; endDate: string }) {
  const months: Array<{ startDate: string; endDate: string }> = [];
  let startDate = window.startDate;
  while (startDate <= window.endDate) {
    const next = new Date(`${startDate}T00:00:00Z`);
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const nextStart = formatDateYmdInTimeZone(next, "UTC");
    next.setUTCDate(0);
    const monthEnd = formatDateYmdInTimeZone(next, "UTC");
    months.push({ startDate, endDate: monthEnd < window.endDate ? monthEnd : window.endDate });
    startDate = nextStart;
  }
  return months;
}
export function buildClimbingStrengths(
  observations: ClimbingStrengthsObservation[],
  window: { startDate?: string; endDate: string },
): ClimbingStrengths {
  const coverage = { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 };
  const groups = new Map<string, ClimbingStrengthsObservation[]>();
  // A missing system can inherit context only from one evidenced system for
  // this identified climb and semantic lane; ambiguous systems stay separate.
  const recognizedContexts = new Map<string, Map<string, ClimbingStrengthsObservation>>();
  for (const entry of observations) {
    if (entry.identity === null || entry.grade === null || entry.gradeSystem === null) continue;
    const key = JSON.stringify([entry.identity, entry.laneKey]);
    const systems = recognizedContexts.get(key) ?? new Map<string, ClimbingStrengthsObservation>();
    systems.set(entry.gradeSystem, entry);
    recognizedContexts.set(key, systems);
  }
  for (const original of observations) {
    const systems = recognizedContexts.get(JSON.stringify([original.identity, original.laneKey]));
    const context =
      original.gradeSystem === null && systems?.size === 1 ? [...systems.values()][0] : undefined;
    const entry = context
      ? {
          ...original,
          contextKey: context.contextKey,
          contextLabel: context.contextLabel,
          gradeSystem: context.gradeSystem,
        }
      : original;
    if (entry.identity === null) {
      coverage.missingIdentity++;
      continue;
    }
    const key = JSON.stringify([entry.contextKey, entry.identity]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const entries: Array<
    ClimbingStrengthsObservation & {
      observations: ClimbingStrengthsObservation[];
    }
  > = [];
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
    const holds = [
      ...new Map(
        group.flatMap((entry) => {
          if (entry.holdTypes === null) return [];
          const holds = [...new Set(entry.holdTypes)].sort();
          return [[JSON.stringify(holds), holds] as const];
        }),
      ).values(),
    ];
    const angles = [
      ...new Map(
        group.flatMap((entry) => {
          const angle = entry.wallAngle;
          if (angle && ("category" in angle || angle.unit === "degrees")) {
            return [[trait(entry, "wall_angle")[0], angle] as const];
          }
          return [];
        }),
      ).values(),
    ];
    entries.push({
      ...preferred,
      observations: group,
      grade: grade.grade,
      gradeSortValue: grade.gradeSortValue,
      setting: settings.length === 1 ? (settings[0] ?? null) : null,
      holdTypes: holds.length === 1 ? (holds[0] ?? null) : null,
      wallAngle: angles.length === 1 ? (angles[0] ?? null) : null,
      example: {
        ...preferred.example,
        grade: grade.grade ?? "",
        outcome: preferred.outcome,
      },
    });
  }
  const startDate =
    window.startDate ??
    observations.reduce(
      (earliest, entry) => (entry.example.date < earliest ? entry.example.date : earliest),
      window.endDate,
    );
  const months = monthlyWindows({ startDate, endDate: window.endDate });
  const panels: ClimbingStrengthsPanel[] = [];
  const contexts = new Set(entries.map((entry) => entry.contextKey));
  const contextKey = contexts.size === 1 ? (entries[0]?.contextKey ?? "selected") : "selected";
  const representative = entries[0];
  const label = representative?.contextLabel ?? "Selected climbs";
  const suffix = representative?.gradeSystem
    ? ` · ${gradeSystemLabel(representative.gradeSystem)}`
    : null;
  const contextLabel =
    contexts.size > 1
      ? "Selected climbs"
      : suffix && label.toLowerCase().endsWith(suffix.toLowerCase())
        ? label.slice(0, -suffix.length)
        : label;
  // Keep same-grade baselines specific to each type and grading system.
  const selected = entries.map((entry) => ({
    ...entry,
    grade: contexts.size > 1 ? `${entry.grade} · ${entry.contextLabel}` : entry.grade,
  }));
  if (selected.length > 0) {
    for (const dimension of ["wall_angle", "hold_type", "setting"] as const) {
      const buildProfile = (allGrades: boolean, cohort: typeof selected) => {
        const gradeGroups = allGrades
          ? [{ grade: ALL_CLIMBING_GRADES, gradeSortValue: 0 }]
          : [
              ...new Map(
                cohort.map((e) => [
                  e.grade,
                  { grade: e.grade ?? "", gradeSortValue: e.gradeSortValue },
                ]),
              ).values(),
            ].sort((a, b) => a.gradeSortValue - b.gradeSortValue || a.grade.localeCompare(b.grade));
        const grades = gradeGroups.map((g) => {
          const matching = cohort.filter((e) => allGrades || e.grade === g.grade);
          const sends = matching.filter((e) => e.outcome === "sent").length;
          const unknownOutcomes = matching.filter((entry) => entry.outcome === null).length;
          return {
            ...g,
            sends,
            climbs: matching.length,
            unknownOutcomes,
            successRate: percent(sends, matching.length - unknownOutcomes),
          };
        });
        const keys =
          dimension === "setting"
            ? [
                "indoor",
                "outdoor",
                ...(cohort.some((entry) => entry.setting === null) ? ["unknown"] : []),
              ]
            : [...new Set(cohort.flatMap((e) => trait(e, dimension)))].sort();
        return {
          grades,
          rows: keys.map((key) => ({
            key,
            label:
              key === "unknown" && dimension === "setting"
                ? "Unknown setting"
                : (key.charAt(0).toUpperCase() + key.slice(1)).replaceAll("_", " "),
            cells: grades.map((g) => {
              const matching = cohort.filter(
                (e) => (allGrades || e.grade === g.grade) && trait(e, dimension).includes(key),
              );
              const sends = matching.filter((e) => e.outcome === "sent").length;
              const unknownOutcomes = matching.filter((entry) => entry.outcome === null).length;
              const successRate = percent(sends, matching.length - unknownOutcomes);
              return {
                grade: g.grade,
                sends,
                climbs: matching.length,
                unknownOutcomes,
                successRate,
                differencePercentagePoints:
                  successRate === null || g.successRate === null
                    ? null
                    : successRate - g.successRate,
                sampleStatus: sampleStatus(matching.length),
                examples: matching.slice(0, 3).map((e) => e.example),
              };
            }),
          })),
          progress: months.map(({ startDate, endDate }) => {
            // Resolve identity, grade and traits across the complete window;
            // only outcomes are re-evaluated from this month's original logs.
            const monthly = cohort.flatMap((entry) => {
              const attempts = entry.observations.filter(
                (observation) =>
                  observation.example.date >= startDate && observation.example.date <= endDate,
              );
              const outcome: ClimbingStrengthsObservation["outcome"] = attempts.some(
                (attempt) => attempt.outcome === "sent",
              )
                ? "sent"
                : attempts.some((attempt) => attempt.outcome === "not_sent")
                  ? "not_sent"
                  : null;
              return attempts.length === 0 ? [] : [{ ...entry, outcome }];
            });
            return {
              startDate,
              endDate,
              rows: keys.map((key) => ({
                key,
                cells: grades.map(({ grade }) => {
                  const matching = monthly.filter(
                    (entry) =>
                      (allGrades || entry.grade === grade) && trait(entry, dimension).includes(key),
                  );
                  const sends = matching.filter((entry) => entry.outcome === "sent").length;
                  const unknownOutcomes = matching.filter((entry) => entry.outcome === null).length;
                  return {
                    grade,
                    sends,
                    climbs: matching.length,
                    unknownOutcomes,
                    successRate: percent(sends, matching.length - unknownOutcomes),
                    sampleStatus: sampleStatus(matching.length),
                  };
                }),
              })),
            };
          }),
        };
      };
      const profile = buildProfile(false, selected);
      const baselineProfile = buildProfile(
        false,
        selected.map((entry) => ({
          ...entry,
          grade: JSON.stringify([entry.contextKey, entry.grade]),
        })),
      );
      panels.push({
        key: JSON.stringify([contextKey, dimension]),
        contextKey,
        contextLabel,
        dimension,
        setting: null,
        ...profile,
        gradeAdjustedStrengths: buildClimbingStrengthProfile(baselineProfile),
        allGrades: buildProfile(true, selected),
        coverage: {
          missingTraits: selected.filter((entry) =>
            dimension === "setting" ? entry.setting === null : trait(entry, dimension).length === 0,
          ).length,
          unknownOutcomes: selected.filter((e) => e.outcome === null).length,
        },
      });
    }
  }
  return { panels, coverage };
}
