import { formatDateYmdInTimeZone } from "@dofek/format/format";
import type { ClimbingWallAngle } from "@dofek/training/climbing-experience";
import { type FreeRockGradeSystem, gradeSystemLabel } from "@dofek/training/climbing-grades";
import type {
  ClimbingStrengths,
  ClimbingStrengthsExample,
  ClimbingStrengthsPanel,
  ClimbingStrengthsTagPanel,
} from "@dofek/training/climbing-strengths";
import { ALL_CLIMBING_GRADES } from "@dofek/training/climbing-strengths";
import type { ClimbingTag } from "@dofek/training/climbing-tags";
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
  tags?: ClimbingTag[];
  outcome: "sent" | "not_sent" | null;
  example: ClimbingStrengthsExample;
}
function contextLabelWithoutSystem(entry: ClimbingStrengthsObservation): string {
  const suffix = entry.gradeSystem ? ` · ${gradeSystemLabel(entry.gradeSystem)}` : null;
  return suffix && entry.contextLabel.toLowerCase().endsWith(suffix.toLowerCase())
    ? entry.contextLabel.slice(0, -suffix.length)
    : entry.contextLabel;
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
const categoryKey = (tag: ClimbingTag) => JSON.stringify([tag.providerId, tag.categoryKey]);
const tagKey = (tag: ClimbingTag) =>
  JSON.stringify([tag.providerId, tag.categoryKey, tag.sourceKey]);
type RecordedTag = { tag: ClimbingTag; order: string };
const latestRecordedTag = (previous: RecordedTag | undefined, current: RecordedTag): RecordedTag =>
  previous && previous.order > current.order ? previous : current;
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
      tagKeysByCategory: Map<string, string[]>;
    }
  > = [];
  const tagCategories = new Map<
    string,
    { latest: RecordedTag; labels: Map<string, RecordedTag> }
  >();
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
    const tags = new Map<string, RecordedTag>();
    for (const entry of group) {
      for (const tag of entry.tags ?? []) {
        // Calendar date wins; source record identity and literal metadata break ties.
        const order = JSON.stringify([
          entry.example.date,
          entry.example.providerId,
          entry.example.logEntryId,
          tag.label,
          tag.categoryLabel,
          tag.sourceKey,
        ]);
        const key = tagKey(tag);
        tags.set(key, latestRecordedTag(tags.get(key), { tag, order }));
      }
    }
    const tagKeysByCategory = new Map<string, string[]>();
    for (const [key, recorded] of tags) {
      const { tag } = recorded;
      const category = categoryKey(tag);
      const keys = tagKeysByCategory.get(category) ?? [];
      keys.push(key);
      tagKeysByCategory.set(category, keys);
      const summary = tagCategories.get(category) ?? {
        latest: recorded,
        labels: new Map<string, RecordedTag>(),
      };
      summary.labels.set(key, latestRecordedTag(summary.labels.get(key), recorded));
      summary.latest = latestRecordedTag(summary.latest, recorded);
      tagCategories.set(category, summary);
    }
    entries.push({
      ...preferred,
      observations: group,
      grade: grade.grade,
      gradeSortValue: grade.gradeSortValue,
      setting: settings.length === 1 ? (settings[0] ?? null) : null,
      holdTypes: holds.length === 1 ? (holds[0] ?? null) : null,
      wallAngle: angles.length === 1 ? (angles[0] ?? null) : null,
      tagKeysByCategory,
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
  const tagPanels: ClimbingStrengthsTagPanel[] = [];
  const contexts = new Set(entries.map((entry) => entry.contextKey));
  const contextKey = contexts.size === 1 ? (entries[0]?.contextKey ?? "selected") : "selected";
  const representative = entries[0];
  const contextLabel =
    contexts.size === 1 && representative
      ? contextLabelWithoutSystem(representative)
      : "Selected climbs";
  // Keep same-grade baselines specific to each type and grading system.
  const selected = entries.map((entry) => {
    const labels = contextLabelWithoutSystem(entry)
      .split(" · ")
      .filter((label) => entry.gradeSystem !== "v_scale" || label !== "Bouldering");
    return {
      ...entry,
      grade: contexts.size > 1 ? [entry.grade, ...labels].join(" · ") : entry.grade,
    };
  });
  if (selected.length > 0) {
    const dimensions: Array<
      {
        values: (entry: (typeof selected)[number]) => string[];
        label: (key: string) => string;
      } & (
        | { dimension: ClimbingStrengthsPanel["dimension"] }
        | { dimension: "tag"; category: ClimbingStrengthsTagPanel["category"] }
      )
    > = (["wall_angle", "hold_type", "setting"] as const).map((dimension) => ({
      dimension,
      values: (entry) => trait(entry, dimension),
      label: (key) =>
        key === "unknown" && dimension === "setting"
          ? "Unknown setting"
          : (key.charAt(0).toUpperCase() + key.slice(1)).replaceAll("_", " "),
    }));
    for (const [
      key,
      {
        latest: { tag },
        labels,
      },
    ] of tagCategories) {
      dimensions.push({
        dimension: "tag",
        category: {
          providerId: tag.providerId,
          key: tag.categoryKey,
          label: tag.categoryLabel ?? tag.categoryKey ?? "Uncategorized tags",
        },
        values: (entry) => entry.tagKeysByCategory.get(key) ?? [],
        label: (key) => labels.get(key)?.tag.label ?? key,
      });
    }
    for (const definition of dimensions) {
      const { dimension, values, label } = definition;
      const category = definition.dimension === "tag" ? definition.category : null;
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
            : [...new Set(cohort.flatMap(values))].sort();
        return {
          grades,
          rows: keys.map((key) => ({
            key,
            label: label(key),
            cells: grades.map((g) => {
              const matching = cohort.filter(
                (e) => (allGrades || e.grade === g.grade) && values(e).includes(key),
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
                    (entry) => (allGrades || entry.grade === grade) && values(entry).includes(key),
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
      const fields = {
        key: JSON.stringify(
          category
            ? [contextKey, dimension, category.providerId, category.key]
            : [contextKey, dimension],
        ),
        contextKey,
        contextLabel,
        setting: null,
        ...profile,
        gradeAdjustedStrengths: buildClimbingStrengthProfile(baselineProfile),
        allGrades: buildProfile(true, selected),
        coverage: {
          missingTraits: selected.filter((entry) =>
            dimension === "setting" ? entry.setting === null : values(entry).length === 0,
          ).length,
          unknownOutcomes: selected.filter((e) => e.outcome === null).length,
        },
      };
      if (definition.dimension === "tag")
        tagPanels.push({
          ...fields,
          dimension: definition.dimension,
          category: definition.category,
        });
      else panels.push({ ...fields, dimension: definition.dimension });
    }
  }
  return { panels, ...(tagPanels.length > 0 ? { tagPanels } : {}), coverage };
}
