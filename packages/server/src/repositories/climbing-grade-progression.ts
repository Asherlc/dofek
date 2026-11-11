import type { FreeRockGradeSystem } from "@dofek/training/climbing-grades";
import type {
  ClimbingGradeProgressionData,
  ClimbingProgressionGrade,
  ClimbingProgressionLaneFacts,
  climbingProgressionSettings,
} from "@dofek/training/climbing-progression";
import {
  buildClimbingProgressionPeriods,
  climbingProgressionPeriodIndex,
} from "./climbing-grade-progression-periods.ts";

export interface ClimbingProgressionEntry extends ClimbingProgressionLaneFacts {
  date: string;
  setting: (typeof climbingProgressionSettings)[number];
  gradeSystem: FreeRockGradeSystem;
  grade: string;
  gradeSortValue: number;
  sends: number;
  unknownOutcomes: number;
}

interface RecordedPeriod {
  days: Set<string>;
  sendsByGrade: Map<string, number>;
  unknownOutcomes: number;
}

export function buildClimbingGradeProgression(
  entries: ClimbingProgressionEntry[],
): ClimbingGradeProgressionData | null {
  if (entries.length === 0) return null;
  const calendar = buildClimbingProgressionPeriods(entries);
  const byGrade = new Map<string, ClimbingProgressionGrade>();
  const byPeriod = new Map<number, RecordedPeriod>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.climbKind, entry.gradeSystem, entry.grade]);
    byGrade.set(key, {
      key,
      climbKind: entry.climbKind,
      gradeSystem: entry.gradeSystem,
      grade: entry.grade,
      gradeSortValue: Math.max(
        byGrade.get(key)?.gradeSortValue ?? entry.gradeSortValue,
        entry.gradeSortValue,
      ),
    });
    const periodIndex = climbingProgressionPeriodIndex(
      entry.date,
      calendar.firstMonth,
      calendar.bucketMonths,
    );
    let recorded = byPeriod.get(periodIndex);
    if (!recorded) {
      recorded = { days: new Set(), sendsByGrade: new Map(), unknownOutcomes: 0 };
      byPeriod.set(periodIndex, recorded);
    }
    recorded.days.add(entry.date);
    recorded.sendsByGrade.set(key, (recorded.sendsByGrade.get(key) ?? 0) + entry.sends);
    recorded.unknownOutcomes += entry.unknownOutcomes;
  }
  const grades = [...byGrade.values()].sort(
    (left, right) =>
      left.climbKind.localeCompare(right.climbKind) ||
      left.gradeSystem.localeCompare(right.gradeSystem) ||
      left.gradeSortValue - right.gradeSortValue ||
      left.grade.localeCompare(right.grade),
  );
  const periods = calendar.periods.map((period, index) => {
    const observations = byPeriod.get(index);
    const climbingDays = observations?.days.size ?? 0;
    let sends = 0;
    const segments = grades.map(({ key }) => {
      const count = observations?.sendsByGrade.get(key) ?? 0;
      const stackStart = climbingDays > 0 ? sends / climbingDays : null;
      sends += count;
      return {
        gradeKey: key,
        sends: count,
        sendsPerDay: climbingDays > 0 ? count / climbingDays : null,
        stackStart,
        stackEnd: climbingDays > 0 ? sends / climbingDays : null,
      };
    });
    return {
      ...period,
      climbingDays,
      sends,
      unknownOutcomes: observations?.unknownOutcomes ?? 0,
      sendsPerDay: climbingDays > 0 ? sends / climbingDays : null,
      segments,
    };
  });
  const maxRate = Math.max(...periods.map((period) => period.sendsPerDay ?? 0));
  const axisInterval = Math.max(1, Math.ceil(maxRate / 3));
  const axisMax = maxRate === 0 ? 1 : axisInterval * 3;
  const axisTicks = Array.from(
    { length: axisMax / axisInterval + 1 },
    (_, index) => index * axisInterval,
  );
  return { grades, periods, axisMax, axisInterval, axisTicks };
}
