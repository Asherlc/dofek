import { formatNumber } from "./format.ts";

/** Row shape returned by `intervals.plannedByActivity`; all metrics are server-computed. */
export interface PlannedIntervalInput {
  intervalIndex: number;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  label: string | null;
  target: { kind: "point"; watts: number } | { kind: "range"; minWatts: number; maxWatts: number };
  plannedDurationSeconds: number;
  recordedTimerDurationSeconds: number | null;
  timerDifferenceSeconds: number | null;
  averagePowerWatts: number | null;
}

export interface PlannedIntervalDisplay {
  /** Stable across merged members: intervalIndex is only local to its source FIT member. */
  key: string;
  name: string;
  recordedPower: string;
  plannedPower: string;
  /** Screen-reader sentence combining the visible values; chart marks are decorative. */
  powerSummary: string;
  timer: string;
  timerDetail: string;
  timerTone: "on-plan" | "short" | "long";
  /** Percent positions on the shared power scale — presentation only. */
  targetStart: number;
  targetWidth: number;
  isPoint: boolean;
  actualPosition: number | null;
  scaleMinWatts: number;
  scaleMaxWatts: number;
}

const toMilliseconds = (seconds: number) => Math.round(seconds * 1000);

/** m:ss for whole seconds, m:ss.mmm when `milliseconds` so a row keeps one precision. */
function formatClock(seconds: number, milliseconds: boolean): string {
  const totalMs = Math.abs(toMilliseconds(seconds));
  const whole = Math.floor(totalMs / 1000);
  const clock = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return milliseconds ? `${clock}.${String(totalMs % 1000).padStart(3, "0")}` : clock;
}

function targetBounds(target: PlannedIntervalInput["target"]): [number, number] {
  return target.kind === "point"
    ? [target.watts, target.watts]
    : [target.minWatts, target.maxWatts];
}

function formatPlannedPower(target: PlannedIntervalInput["target"]): string {
  if (target.kind === "point") return `${formatNumber(target.watts, 0)} W planned`;
  return `${formatNumber(target.minWatts, 0)}–${formatNumber(target.maxWatts, 0)} W planned`;
}

/** Formats server planned-versus-recorded rows for display; empty input yields no rows. */
export function formatPlannedIntervals(rows: PlannedIntervalInput[]): PlannedIntervalDisplay[] {
  const values = rows.flatMap((row) => [
    ...targetBounds(row.target),
    ...(row.averagePowerWatts == null ? [] : [row.averagePowerWatts]),
  ]);
  const lowest = Math.floor(Math.min(...values) / 5) * 5;
  const highest = Math.ceil(Math.max(...values) / 5) * 5;
  // A single fixed wattage has no extent; pad it so the point sits mid-scale.
  const degenerate = lowest === highest;
  const minWatts = degenerate ? Math.max(0, lowest - 5) : lowest;
  const maxWatts = degenerate ? highest + 5 : highest;
  const span = maxWatts - minWatts;
  const position = (watts: number) => ((watts - minWatts) / span) * 100;

  return rows.map((row) => {
    const [low, high] = targetBounds(row.target);
    const difference = row.timerDifferenceSeconds;
    const fractional = [
      row.plannedDurationSeconds,
      row.recordedTimerDurationSeconds,
      difference,
    ].some((seconds) => seconds != null && toMilliseconds(seconds) % 1000 !== 0);
    const planned = formatClock(row.plannedDurationSeconds, fractional);
    const hasTimer = row.recordedTimerDurationSeconds != null;
    const timerTone =
      !hasTimer || difference == null || toMilliseconds(difference) === 0
        ? "on-plan"
        : difference < 0
          ? "short"
          : "long";
    const timerDetail =
      timerTone === "short" && difference != null
        ? `${formatClock(difference, fractional)} short of ${planned}`
        : timerTone === "long" && difference != null
          ? `${formatClock(difference, fractional)} longer than ${planned}`
          : `${planned} planned`;
    const recordedPower =
      row.averagePowerWatts == null
        ? "Power unavailable"
        : `${formatNumber(row.averagePowerWatts, 0)} W recorded`;
    const plannedPower = formatPlannedPower(row.target);
    const timer =
      row.recordedTimerDurationSeconds == null
        ? "Timer unavailable"
        : formatClock(row.recordedTimerDurationSeconds, fractional);
    const name = row.label ?? `Interval ${row.intervalIndex + 1}`;
    return {
      key: `${row.startOffsetSeconds}-${row.endOffsetSeconds}-${row.intervalIndex}`,
      name,
      recordedPower,
      plannedPower,
      powerSummary: `${name}: ${recordedPower}, ${plannedPower}. ${hasTimer ? `Timer ${timer}` : timer}, ${timerDetail}.`,
      timer,
      timerDetail,
      timerTone,
      targetStart: position(low),
      targetWidth: position(high) - position(low),
      isPoint: row.target.kind === "point",
      actualPosition: row.averagePowerWatts == null ? null : position(row.averagePowerWatts),
      scaleMinWatts: minWatts,
      scaleMaxWatts: maxWatts,
    };
  });
}

export const PLANNED_INTERVAL_MATCH_SUMMARY = "How intervals were matched";
export const PLANNED_INTERVAL_MATCH_EXPLANATION =
  "Each row pairs a lap with the workout step it references in the same FIT file. Timer duration excludes pauses.";
