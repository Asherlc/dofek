import {
  climbingProgressionLaneKey,
  climbingProgressionSettings,
} from "@dofek/training/climbing-progression";
import type { ClimbingGradeProgressionV1Lane } from "@dofek/training/climbing-progression-v1";
import type { ClimbingProgressionEntry } from "./climbing-grade-progression.ts";
import {
  buildClimbingProgressionPeriods,
  climbingProgressionPeriodIndex,
} from "./climbing-grade-progression-periods.ts";

interface RecordedPeriod {
  days: Set<string>;
  sendsByGrade: Map<string, number>;
  unknownOutcomes: number;
}

interface RecordedLane
  extends Pick<
    ClimbingProgressionEntry,
    "climbKind" | "attemptScope" | "ropeMethod" | "solo" | "usedAid" | "gradeSystem"
  > {
  grades: Map<string, number>;
  settings: Set<ClimbingProgressionEntry["setting"]>;
  periods: Map<string, RecordedPeriod>;
}

export function buildClimbingGradeProgressionV1(
  entries: ClimbingProgressionEntry[],
): ClimbingGradeProgressionV1Lane[] {
  if (entries.length === 0) return [];
  const { firstMonth, bucketMonths, periods } = buildClimbingProgressionPeriods(entries);
  const byLane = new Map<string, RecordedLane>();
  for (const entry of entries) {
    // A retained source scale remains a separate lane after preference conversion.
    const key = `${climbingProgressionLaneKey(entry)}:${entry.gradeSystem}`;
    let lane = byLane.get(key);
    if (!lane) {
      lane = {
        climbKind: entry.climbKind,
        attemptScope: entry.attemptScope,
        ropeMethod: entry.ropeMethod,
        solo: entry.solo,
        usedAid: entry.usedAid,
        gradeSystem: entry.gradeSystem,
        grades: new Map(),
        settings: new Set(),
        periods: new Map(),
      };
      byLane.set(key, lane);
    }
    lane.grades.set(
      entry.grade,
      Math.max(lane.grades.get(entry.grade) ?? entry.gradeSortValue, entry.gradeSortValue),
    );
    lane.settings.add(entry.setting);
    const periodIndex = climbingProgressionPeriodIndex(entry.date, firstMonth, bucketMonths);
    const periodKey = `${periodIndex}:${entry.setting}`;
    let recorded = lane.periods.get(periodKey);
    if (!recorded) {
      recorded = { days: new Set(), sendsByGrade: new Map(), unknownOutcomes: 0 };
      lane.periods.set(periodKey, recorded);
    }
    recorded.days.add(entry.date);
    recorded.sendsByGrade.set(
      entry.grade,
      (recorded.sendsByGrade.get(entry.grade) ?? 0) + entry.sends,
    );
    recorded.unknownOutcomes += entry.unknownOutcomes;
  }

  const lanes = [...byLane.values()]
    .sort(
      (left, right) =>
        climbingProgressionLaneKey(left).localeCompare(climbingProgressionLaneKey(right)) ||
        left.gradeSystem.localeCompare(right.gradeSystem),
    )
    .map((recorded) => {
      const grades = [...recorded.grades]
        .map(([grade, gradeSortValue]) => ({ grade, gradeSortValue }))
        .sort(
          (left, right) =>
            left.gradeSortValue - right.gradeSortValue || left.grade.localeCompare(right.grade),
        );
      const settings = climbingProgressionSettings.filter((setting) =>
        recorded.settings.has(setting),
      );
      return {
        climbKind: recorded.climbKind,
        attemptScope: recorded.attemptScope,
        ropeMethod: recorded.ropeMethod,
        solo: recorded.solo,
        usedAid: recorded.usedAid,
        gradeSystem: recorded.gradeSystem,
        grades,
        settings,
        periods: periods.map((period, index) => ({
          ...period,
          settings: settings.map((setting) => {
            const observations = recorded.periods.get(`${index}:${setting}`);
            const climbingDays = observations?.days.size ?? 0;
            let sends = 0;
            const segments = grades.map(({ grade }) => {
              const count = observations?.sendsByGrade.get(grade) ?? 0;
              const stackStart = climbingDays > 0 ? sends / climbingDays : null;
              sends += count;
              return {
                grade,
                sends: count,
                sendsPerDay: climbingDays > 0 ? count / climbingDays : null,
                stackStart,
                stackEnd: climbingDays > 0 ? sends / climbingDays : null,
              };
            });
            return {
              setting,
              climbingDays,
              sends,
              unknownOutcomes: observations?.unknownOutcomes ?? 0,
              sendsPerDay: climbingDays > 0 ? sends / climbingDays : null,
              segments,
            };
          }),
        })),
      };
    });
  const maxRate = Math.max(
    ...lanes.flatMap((lane) =>
      lane.periods.flatMap((period) => period.settings.map((setting) => setting.sendsPerDay ?? 0)),
    ),
  );
  const axisInterval = Math.max(1, Math.ceil(maxRate / 3));
  const axisMax = maxRate === 0 ? 1 : axisInterval * 3;
  const axisTicks = Array.from(
    { length: axisMax / axisInterval + 1 },
    (_, index) => index * axisInterval,
  );
  return lanes.map((lane) => ({ ...lane, axisMax, axisInterval, axisTicks }));
}
