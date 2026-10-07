import {
  type ClimbingGradeProgressionLane,
  climbingProgressionSettings,
  climbingProgressionStyles,
} from "@dofek/training/climbing-progression";

export interface ClimbingProgressionEntry {
  date: string;
  style: ClimbingGradeProgressionLane["style"];
  climbType: ClimbingGradeProgressionLane["climbType"];
  setting: ClimbingGradeProgressionLane["settings"][number];
  gradeSystem: ClimbingGradeProgressionLane["gradeSystem"];
  grade: string;
  gradeSortValue: number;
  sent: boolean | null;
}

interface RecordedPeriod {
  days: Set<string>;
  sendsByGrade: Map<string, number>;
  unknownOutcomes: number;
}

interface RecordedLane {
  style: ClimbingProgressionEntry["style"];
  climbType: ClimbingProgressionEntry["climbType"];
  gradeSystem: ClimbingProgressionEntry["gradeSystem"];
  grades: Map<string, number>;
  settings: Set<ClimbingProgressionEntry["setting"]>;
  periods: Map<string, RecordedPeriod>;
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthDate(month: number, day = 1): Date {
  return new Date(Date.UTC(Math.floor(month / 12), month % 12, day));
}

export function buildClimbingGradeProgression(
  entries: ClimbingProgressionEntry[],
): ClimbingGradeProgressionLane[] {
  if (entries.length === 0) return [];
  const months = entries.map((entry) => monthIndex(entry.date));
  const firstMonth = Math.min(...months);
  const lastMonth = Math.max(...months);
  const bucketMonths = Math.ceil((lastMonth - firstMonth + 1) / 6);
  const periods = Array.from(
    { length: Math.ceil((lastMonth - firstMonth + 1) / bucketMonths) },
    (_, index) => ({
      startDate: monthDate(firstMonth + index * bucketMonths)
        .toISOString()
        .slice(0, 10),
      endDate: monthDate(Math.min(firstMonth + (index + 1) * bucketMonths, lastMonth + 1), 0)
        .toISOString()
        .slice(0, 10),
    }),
  );
  const byLane = new Map<string, RecordedLane>();
  for (const entry of entries) {
    // Conversion can retain a source scale; keep those scales in separate lanes.
    const key = `${entry.style}:${entry.gradeSystem}`;
    let lane = byLane.get(key);
    if (!lane) {
      lane = {
        style: entry.style,
        climbType: entry.climbType,
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
    const periodIndex = Math.floor((monthIndex(entry.date) - firstMonth) / bucketMonths);
    const periodKey = `${periodIndex}:${entry.setting}`;
    let recorded = lane.periods.get(periodKey);
    if (!recorded) {
      recorded = { days: new Set(), sendsByGrade: new Map(), unknownOutcomes: 0 };
      lane.periods.set(periodKey, recorded);
    }
    recorded.days.add(entry.date);
    if (entry.sent === true) {
      recorded.sendsByGrade.set(entry.grade, (recorded.sendsByGrade.get(entry.grade) ?? 0) + 1);
    } else if (entry.sent === null) recorded.unknownOutcomes++;
  }

  const lanes = [...byLane.values()]
    .sort(
      (left, right) =>
        climbingProgressionStyles.indexOf(left.style) -
          climbingProgressionStyles.indexOf(right.style) ||
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
        style: recorded.style,
        climbType: recorded.climbType,
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
