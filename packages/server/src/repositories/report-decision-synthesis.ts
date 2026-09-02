export interface ReportDecisionSynthesis {
  whatChanged: string[];
  likelyAssociations: string[];
  whatWorked: string[];
  whatToTryNext: string[];
  confidenceAndMissingData: string[];
}

interface WeeklyDecisionPeriod {
  trainingHours: number;
  activityCount: number;
  avgSleepMinutes: number;
  avgRestingHr: number | null;
  avgHrv: number | null;
}

interface MonthlyDecisionPeriod extends WeeklyDecisionPeriod {
  trainingHoursTrend: number | null;
  avgSleepTrend: number | null;
}

type PeriodKind = "week" | "month";

function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatHours(hours: number): string {
  const roundedHours = Math.round(hours * 10) / 10;
  const value = formatNumber(roundedHours);
  return `${value} ${roundedHours === 1 ? "hour" : "hours"}`;
}

function formatDuration(minutes: number): string {
  const roundedMinutes = Math.round(minutes);
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (remainder > 0) parts.push(`${remainder} ${remainder === 1 ? "minute" : "minutes"}`);
  return parts.length === 0 ? "0 minutes" : parts.join(" ");
}

function relativeChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1_000) / 10;
}

function describeTrainingChange(
  current: number,
  previous: number,
  kind: PeriodKind,
  suppliedTrend?: number | null,
): string {
  const change = suppliedTrend ?? relativeChange(current, previous);
  if (change == null) {
    return current > 0
      ? `Training was ${formatHours(current)}, up from no recorded training in the previous ${kind}.`
      : `No training was recorded in either the current or previous ${kind}.`;
  }
  if (change === 0) {
    return `Training held steady at ${formatHours(current)} versus the previous ${kind}.`;
  }
  return `Training was ${formatHours(current)}, ${formatNumber(Math.abs(change))}% ${
    change > 0 ? "more" : "less"
  } than the previous ${kind}.`;
}

function describeWeeklySleepChange(current: number, previous: number): string {
  if (current <= 0 || previous <= 0) {
    return "A week-over-week sleep change is unavailable because sleep was not tracked in both weeks.";
  }
  const difference = Math.round(current - previous);
  if (difference === 0) {
    return `Average nightly sleep held steady at ${formatDuration(current)}.`;
  }
  return `Average nightly sleep was ${formatDuration(current)}, ${formatDuration(
    Math.abs(difference),
  )} ${difference > 0 ? "more" : "less"} than the previous week.`;
}

function describeMonthlySleepChange(current: number, trend: number | null): string {
  if (current <= 0 || trend == null) {
    return "A month-over-month sleep change is unavailable because sleep was not tracked in both months.";
  }
  if (trend === 0) {
    return `Average nightly sleep held steady at ${formatDuration(current)}.`;
  }
  return `Average nightly sleep was ${formatDuration(current)}, ${formatNumber(
    Math.abs(trend),
  )}% ${trend > 0 ? "more" : "less"} than the previous month.`;
}

function comparisonDirection(current: number, previous: number): "higher" | "lower" | "steady" {
  if (current > previous) return "higher";
  if (current < previous) return "lower";
  return "steady";
}

function buildAssociation(
  current: WeeklyDecisionPeriod,
  previous: WeeklyDecisionPeriod | undefined,
  kind: PeriodKind,
): string {
  if (
    !previous ||
    current.avgSleepMinutes <= 0 ||
    previous.avgSleepMinutes <= 0 ||
    current.avgHrv == null ||
    previous.avgHrv == null
  ) {
    return `No training-and-recovery association can be assessed yet because there is no comparison ${kind} with tracked sleep and recovery.`;
  }

  const training = comparisonDirection(current.trainingHours, previous.trainingHours);
  const sleep = comparisonDirection(current.avgSleepMinutes, previous.avgSleepMinutes);
  const heartRateVariability = comparisonDirection(current.avgHrv, previous.avgHrv);

  if (training === "steady") {
    return `With training volume steady, sleep was ${sleep} and heart rate variability was ${heartRateVariability} this ${kind}. This is a descriptive association, not evidence that one change caused another.`;
  }

  return `${training === "higher" ? "Higher" : "Lower"} training coincided with ${
    sleep === "higher" ? "more" : sleep === "lower" ? "less" : "steady"
  } sleep and ${
    heartRateVariability === "higher"
      ? "higher"
      : heartRateVariability === "lower"
        ? "lower"
        : "steady"
  } heart rate variability this ${kind}. This is a descriptive association, not evidence that one change caused another.`;
}

function buildWhatWorked(
  current: WeeklyDecisionPeriod,
  previous: WeeklyDecisionPeriod | undefined,
  kind: PeriodKind,
): string {
  if (!previous) {
    return "There is not enough history yet to identify a repeatable positive pattern.";
  }

  const trainingSteady = Math.abs(current.trainingHours - previous.trainingHours) < 0.1;
  const sleepDidNotFall =
    previous.avgSleepMinutes > 0 && current.avgSleepMinutes >= previous.avgSleepMinutes;
  const restingHeartRateDidNotRise =
    current.avgRestingHr != null &&
    previous.avgRestingHr != null &&
    current.avgRestingHr <= previous.avgRestingHr;
  const heartRateVariabilityDidNotFall =
    current.avgHrv != null && previous.avgHrv != null && current.avgHrv >= previous.avgHrv;

  if (
    trainingSteady &&
    sleepDidNotFall &&
    restingHeartRateDidNotRise &&
    heartRateVariabilityDidNotFall
  ) {
    return "Training volume stayed steady while sleep, resting heart rate, and heart rate variability were stable or improved.";
  }

  if (sleepDidNotFall && heartRateVariabilityDidNotFall) {
    return `You completed ${current.activityCount} ${
      current.activityCount === 1 ? "activity" : "activities"
    } while sleep and heart rate variability were stable or improved.`;
  }

  return `You completed ${current.activityCount} ${
    current.activityCount === 1 ? "activity" : "activities"
  }; no recovery improvement is clear in the available ${kind}ly metrics.`;
}

function missingData(current: WeeklyDecisionPeriod): string[] {
  const missing: string[] = [];
  if (current.avgSleepMinutes <= 0) missing.push("sleep");
  if (current.avgRestingHr == null) missing.push("resting heart rate");
  if (current.avgHrv == null) missing.push("heart rate variability");
  return missing;
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function confidenceAndMissingData(
  current: WeeklyDecisionPeriod,
  periodCount: number,
  kind: PeriodKind,
): string[] {
  const missing = missingData(current);
  const periodLabel = `${kind}ly periods`;
  const confidence =
    periodCount >= 4 && missing.length === 0
      ? `Confidence is moderate because ${periodCount} ${periodLabel} are available and the current period includes sleep and recovery data.`
      : periodCount >= 4
        ? "Confidence is limited because current-period recovery data is incomplete."
        : `Confidence is ${periodCount === 1 ? "low" : "limited"} because only ${periodCount} ${periodLabel.slice(
            0,
            -1,
          )}${periodCount === 1 ? "" : "s"} ${periodCount === 1 ? "is" : "are"} available.`;
  const result = [
    confidence,
    "These period averages can show co-movement, but they cannot establish cause and effect.",
  ];
  if (missing.length > 0) {
    result.push(`Missing current-period data: ${joinList(missing)}.`);
  }
  return result;
}

function buildNextStep(
  current: WeeklyDecisionPeriod,
  previous: WeeklyDecisionPeriod | undefined,
  kind: PeriodKind,
): string {
  if (missingData(current).length > 0) {
    return `Track sleep and recovery through the next ${kind} so the report can compare training with recovery.`;
  }
  if (!previous) {
    return `Repeat or deliberately adjust one part of the routine next ${kind}, then compare it with this baseline.`;
  }
  if (
    current.trainingHours > previous.trainingHours &&
    current.avgSleepMinutes < previous.avgSleepMinutes
  ) {
    return `Keep training near ${formatHours(
      current.trainingHours,
    )} and protect the sleep schedule next ${kind}, then compare sleep and recovery again before increasing volume.`;
  }
  return `Keep one major input steady next ${kind}—training volume or sleep schedule—so the following comparison is easier to interpret.`;
}

export function buildWeeklyDecisionSynthesis(
  current: WeeklyDecisionPeriod,
  history: WeeklyDecisionPeriod[],
): ReportDecisionSynthesis {
  const previous = history.at(-1);
  return {
    whatChanged: previous
      ? [
          describeTrainingChange(current.trainingHours, previous.trainingHours, "week"),
          describeWeeklySleepChange(current.avgSleepMinutes, previous.avgSleepMinutes),
        ]
      : ["This is the first observed week, so week-over-week changes are not available yet."],
    likelyAssociations: [buildAssociation(current, previous, "week")],
    whatWorked: [buildWhatWorked(current, previous, "week")],
    whatToTryNext: [buildNextStep(current, previous, "week")],
    confidenceAndMissingData: confidenceAndMissingData(current, history.length + 1, "week"),
  };
}

export function buildMonthlyDecisionSynthesis(
  current: MonthlyDecisionPeriod,
  history: MonthlyDecisionPeriod[],
): ReportDecisionSynthesis {
  const previous = history.at(-1);
  return {
    whatChanged: previous
      ? [
          describeTrainingChange(
            current.trainingHours,
            previous.trainingHours,
            "month",
            current.trainingHoursTrend,
          ),
          describeMonthlySleepChange(current.avgSleepMinutes, current.avgSleepTrend),
        ]
      : ["This is the first observed month, so month-over-month changes are not available yet."],
    likelyAssociations: [buildAssociation(current, previous, "month")],
    whatWorked: [buildWhatWorked(current, previous, "month")],
    whatToTryNext: [buildNextStep(current, previous, "month")],
    confidenceAndMissingData: confidenceAndMissingData(current, history.length + 1, "month"),
  };
}
