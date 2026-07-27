import { CORRELATION_METRICS } from "@dofek/stats/correlation";

const METRIC_LABEL_BY_ID = new Map(CORRELATION_METRICS.map((metric) => [metric.id, metric.label]));

export type PersonalExperimentStatus = "active" | "stopped";
export type PersonalExperimentPhase =
  | "upcoming"
  | "baseline"
  | "intervention"
  | "complete"
  | "stopped";

export interface ExperimentScheduleInput {
  startDate: string;
  baselineDays: number;
  interventionDays: number;
  status: PersonalExperimentStatus;
  stoppedAt: string | null;
  today: string;
}

export interface ExperimentSchedule {
  phase: PersonalExperimentPhase;
  phaseLabel: string;
  baselineStartDate: string;
  baselineEndDate: string;
  interventionStartDate: string;
  interventionEndDate: string;
  dayInPhase: number | null;
  daysRemainingInPhase: number | null;
  scheduleSummary: string;
}

export function resolveOutcomeMetricLabel(outcomeMetricId: string): string {
  return METRIC_LABEL_BY_ID.get(outcomeMetricId) ?? outcomeMetricId;
}

export function isKnownOutcomeMetricId(outcomeMetricId: string): boolean {
  return METRIC_LABEL_BY_ID.has(outcomeMetricId);
}

export function resolveExperimentSchedule(input: ExperimentScheduleInput): ExperimentSchedule {
  const baselineStartDate = input.startDate;
  const baselineEndDate = addDays(input.startDate, input.baselineDays - 1);
  const interventionStartDate = addDays(baselineEndDate, 1);
  const interventionEndDate = addDays(interventionStartDate, input.interventionDays - 1);

  if (input.status === "stopped") {
    return {
      phase: "stopped",
      phaseLabel: "Stopped",
      baselineStartDate,
      baselineEndDate,
      interventionStartDate,
      interventionEndDate,
      dayInPhase: null,
      daysRemainingInPhase: null,
      scheduleSummary: `Stopped on ${input.stoppedAt ?? input.today}`,
    };
  }

  if (input.today < input.startDate) {
    return {
      phase: "upcoming",
      phaseLabel: "Upcoming",
      baselineStartDate,
      baselineEndDate,
      interventionStartDate,
      interventionEndDate,
      dayInPhase: null,
      daysRemainingInPhase: null,
      scheduleSummary: `Starts on ${input.startDate}`,
    };
  }

  if (input.today <= baselineEndDate) {
    const dayInPhase = daysBetween(baselineStartDate, input.today) + 1;
    const daysRemainingInPhase = daysBetween(input.today, baselineEndDate) + 1;
    return {
      phase: "baseline",
      phaseLabel: "Baseline",
      baselineStartDate,
      baselineEndDate,
      interventionStartDate,
      interventionEndDate,
      dayInPhase,
      daysRemainingInPhase,
      scheduleSummary: `Day ${dayInPhase} of baseline (${formatDaysRemaining(daysRemainingInPhase)})`,
    };
  }

  if (input.today <= interventionEndDate) {
    const dayInPhase = daysBetween(interventionStartDate, input.today) + 1;
    const daysRemainingInPhase = daysBetween(input.today, interventionEndDate) + 1;
    return {
      phase: "intervention",
      phaseLabel: "Intervention",
      baselineStartDate,
      baselineEndDate,
      interventionStartDate,
      interventionEndDate,
      dayInPhase,
      daysRemainingInPhase,
      scheduleSummary: `Day ${dayInPhase} of intervention (${formatDaysRemaining(daysRemainingInPhase)})`,
    };
  }

  return {
    phase: "complete",
    phaseLabel: "Complete",
    baselineStartDate,
    baselineEndDate,
    interventionStartDate,
    interventionEndDate,
    dayInPhase: null,
    daysRemainingInPhase: null,
    scheduleSummary: `Experiment schedule finished on ${interventionEndDate}`,
  };
}

function formatDaysRemaining(daysRemaining: number): string {
  return daysRemaining === 1 ? "1 day remaining" : `${daysRemaining} days remaining`;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): number {
  const startTime = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const endTime = new Date(`${endDate}T00:00:00.000Z`).getTime();
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((endTime - startTime) / millisecondsPerDay);
}
