import {
  type BootstrapInterval,
  circularMovingBlockBootstrapInterval,
} from "@dofek/stats/block-bootstrap";

const MIN_OUTCOME_COUNT = 5;

export type ExperimentAdherence = "adherent" | "partial" | "not_adherent" | "unknown";
export type ExperimentAnalysisPhase = "baseline" | "intervention";

export interface ExperimentAnalysisSchedule {
  baselineStartDate: string;
  baselineEndDate: string;
  interventionStartDate: string;
  interventionEndDate: string;
}

export interface ExperimentAnalysisCheckIn {
  date: string;
  adherence: ExperimentAdherence;
  confounder: string | null;
  note: string | null;
}

export interface ExperimentCanonicalOutcome {
  date: string;
  value: number;
  sourceProviderIds: string[];
}

export interface ExperimentAnalysisInput {
  lagDays: number;
  schedule: ExperimentAnalysisSchedule;
  checkIns: ExperimentAnalysisCheckIn[];
  outcomes: ExperimentCanonicalOutcome[];
}

export interface ExperimentOutcomeObservation {
  phase: ExperimentAnalysisPhase;
  phaseDate: string;
  outcomeDate: string;
  value: number | null;
  adherence: ExperimentAdherence | null;
  confounder: string | null;
  note: string | null;
  sourceProviderIds: string[];
}

export interface ExperimentPhaseCoverage {
  expectedDayCount: number;
  observedOutcomeDayCount: number;
  missingOutcomeDayCount: number;
  checkInCount: number;
  adherenceCounts: Record<ExperimentAdherence, number>;
}

export interface ExperimentAnalysisCoverage {
  baseline: ExperimentPhaseCoverage;
  intervention: ExperimentPhaseCoverage;
}

export interface ExperimentEffect {
  baselineMean: number;
  interventionMean: number;
  differenceInMeans: number;
  baselineSampleCount: number;
  interventionSampleCount: number;
}

export type ExperimentUncertainty =
  | BootstrapInterval
  | {
      availability: "unavailable";
      method: "circular_moving_block_bootstrap";
      level: 0.95;
      blockLength: number;
      requestedReplicateCount: 2_000;
      attemptedReplicateCount: 0;
      validReplicateCount: 0;
      reason: "insufficient_outcomes";
    };

export type ExperimentAnalysis =
  | {
      availability: "available";
      observations: ExperimentOutcomeObservation[];
      coverage: ExperimentAnalysisCoverage;
      effect: ExperimentEffect;
      uncertainty: ExperimentUncertainty;
      limitations: string[];
    }
  | {
      availability: "insufficient";
      observations: ExperimentOutcomeObservation[];
      coverage: ExperimentAnalysisCoverage;
      effect: null;
      uncertainty: ExperimentUncertainty;
      limitations: string[];
    };

export function buildExperimentAnalysis(input: ExperimentAnalysisInput): ExperimentAnalysis {
  const checkInByDate = new Map(input.checkIns.map((checkIn) => [checkIn.date, checkIn]));
  const outcomeByDate = new Map(input.outcomes.map((outcome) => [outcome.date, outcome]));
  const observations = [
    ...buildPhaseObservations(
      "baseline",
      input.schedule.baselineStartDate,
      input.schedule.baselineEndDate,
      input.lagDays,
      checkInByDate,
      outcomeByDate,
    ),
    ...buildPhaseObservations(
      "intervention",
      input.schedule.interventionStartDate,
      input.schedule.interventionEndDate,
      input.lagDays,
      checkInByDate,
      outcomeByDate,
    ),
  ];
  const coverage = {
    baseline: buildCoverage(observations, "baseline"),
    intervention: buildCoverage(observations, "intervention"),
  };
  const baselineValues = observedValues(
    observations,
    (observation) => observation.phase === "baseline",
  );
  const interventionValues = observedValues(
    observations,
    (observation) =>
      observation.phase === "intervention" &&
      (observation.adherence === "adherent" || observation.adherence === "partial"),
  );
  const limitations = buildLimitations(observations, coverage);

  if (baselineValues.length < MIN_OUTCOME_COUNT || interventionValues.length < MIN_OUTCOME_COUNT) {
    return {
      availability: "insufficient",
      observations,
      coverage,
      effect: null,
      uncertainty: unavailableUncertainty(observations.length),
      limitations: [
        ...limitations,
        `At least ${MIN_OUTCOME_COUNT} observed baseline outcomes and ${MIN_OUTCOME_COUNT} adherent or partial intervention outcomes are required.`,
      ],
    };
  }

  const uncertainty = circularMovingBlockBootstrapInterval(observations, (sample) => {
    const baseline = observedValues(sample, (observation) => observation.phase === "baseline");
    const intervention = observedValues(
      sample,
      (observation) =>
        observation.phase === "intervention" &&
        (observation.adherence === "adherent" || observation.adherence === "partial"),
    );
    if (baseline.length < MIN_OUTCOME_COUNT || intervention.length < MIN_OUTCOME_COUNT) return null;
    return mean(intervention) - mean(baseline);
  });

  return {
    availability: "available",
    observations,
    coverage,
    effect: {
      baselineMean: mean(baselineValues),
      interventionMean: mean(interventionValues),
      differenceInMeans: mean(interventionValues) - mean(baselineValues),
      baselineSampleCount: baselineValues.length,
      interventionSampleCount: interventionValues.length,
    },
    uncertainty,
    limitations,
  };
}

function buildPhaseObservations(
  phase: ExperimentAnalysisPhase,
  startDate: string,
  endDate: string,
  lagDays: number,
  checkInByDate: ReadonlyMap<string, ExperimentAnalysisCheckIn>,
  outcomeByDate: ReadonlyMap<string, ExperimentCanonicalOutcome>,
): ExperimentOutcomeObservation[] {
  return calendarDates(startDate, endDate).map((phaseDate) => {
    const outcomeDate = addCalendarDays(phaseDate, lagDays);
    const outcome = outcomeByDate.get(outcomeDate);
    const checkIn = phase === "intervention" ? checkInByDate.get(phaseDate) : undefined;
    return {
      phase,
      phaseDate,
      outcomeDate,
      value: outcome?.value ?? null,
      adherence: checkIn?.adherence ?? null,
      confounder: checkIn?.confounder ?? null,
      note: checkIn?.note ?? null,
      sourceProviderIds: outcome?.sourceProviderIds ?? [],
    };
  });
}

function buildCoverage(
  observations: ExperimentOutcomeObservation[],
  phase: ExperimentAnalysisPhase,
): ExperimentPhaseCoverage {
  const phaseObservations = observations.filter((observation) => observation.phase === phase);
  const adherenceCounts: Record<ExperimentAdherence, number> = {
    adherent: 0,
    partial: 0,
    not_adherent: 0,
    unknown: 0,
  };
  for (const observation of phaseObservations) {
    if (observation.adherence !== null) adherenceCounts[observation.adherence]++;
  }
  const observedOutcomeDayCount = phaseObservations.filter(
    (observation) => observation.value !== null,
  ).length;
  return {
    expectedDayCount: phaseObservations.length,
    observedOutcomeDayCount,
    missingOutcomeDayCount: phaseObservations.length - observedOutcomeDayCount,
    checkInCount: phaseObservations.filter((observation) => observation.adherence !== null).length,
    adherenceCounts,
  };
}

function observedValues(
  observations: readonly ExperimentOutcomeObservation[],
  includes: (observation: ExperimentOutcomeObservation) => boolean,
): number[] {
  return observations.flatMap((observation) =>
    includes(observation) && observation.value !== null ? [observation.value] : [],
  );
}

function buildLimitations(
  observations: ExperimentOutcomeObservation[],
  coverage: ExperimentAnalysisCoverage,
): string[] {
  const limitations = ["This is an observational comparison, not a causal conclusion."];
  const missingOutcomeDayCount =
    coverage.baseline.missingOutcomeDayCount + coverage.intervention.missingOutcomeDayCount;
  if (missingOutcomeDayCount > 0) {
    limitations.push(
      `${missingOutcomeDayCount} scheduled outcome ${pluralize(missingOutcomeDayCount, "day")} ${missingOutcomeDayCount === 1 ? "is" : "are"} missing from the canonical metric.`,
    );
  }
  const { adherenceCounts } = coverage.intervention;
  if (adherenceCounts.not_adherent > 0) {
    limitations.push(
      `${adherenceCounts.not_adherent} intervention ${pluralize(adherenceCounts.not_adherent, "day")} ${adherenceCounts.not_adherent === 1 ? "was" : "were"} marked not adherent.`,
    );
  }
  if (adherenceCounts.unknown > 0) {
    limitations.push(
      `${adherenceCounts.unknown} intervention ${pluralize(adherenceCounts.unknown, "day")} ${adherenceCounts.unknown === 1 ? "has" : "have"} unknown adherence.`,
    );
  }
  const missingCheckInCount =
    coverage.intervention.expectedDayCount - coverage.intervention.checkInCount;
  if (missingCheckInCount > 0) {
    limitations.push(
      `${missingCheckInCount} intervention ${pluralize(missingCheckInCount, "day")} ${missingCheckInCount === 1 ? "has" : "have"} no check-in.`,
    );
  }
  const confounderCount = observations.filter(
    (observation) => observation.phase === "intervention" && observation.confounder !== null,
  ).length;
  if (confounderCount > 0) {
    limitations.push(
      `${confounderCount} linked ${pluralize(confounderCount, "confounder")} ${confounderCount === 1 ? "was" : "were"} recorded.`,
    );
  }
  if (observations.some((observation) => observation.sourceProviderIds.length > 1)) {
    limitations.push("One or more outcome days include multiple provider sources.");
  }
  return limitations;
}

function unavailableUncertainty(
  observationCount: number,
): Extract<ExperimentUncertainty, { reason: "insufficient_outcomes" }> {
  return {
    availability: "unavailable",
    method: "circular_moving_block_bootstrap",
    level: 0.95,
    blockLength: Math.ceil(Math.cbrt(observationCount)),
    requestedReplicateCount: 2_000,
    attemptedReplicateCount: 0,
    validReplicateCount: 0,
    reason: "insufficient_outcomes",
  };
}

function calendarDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addCalendarDays(date, 1)) dates.push(date);
  return dates;
}

function addCalendarDays(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
