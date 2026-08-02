export type TodayPlanConfidence = "high" | "moderate" | "low";
export type TodayPlanZone = "Push" | "Maintain" | "Recovery";
export type TodayPlanSleepTier = "Excellent" | "Good" | "Fair" | "Poor";

export interface TodayPlanSupportingFact {
  label: string;
  value: string;
}

export interface TodayPlanAction {
  id: "strain_target";
  title: string;
  summary: string;
  zone: TodayPlanZone;
}

export interface TodayPlanFreshness {
  recoveryDate: string | null;
  sleepDate: string | null;
}

export interface TodayPlanStrainTargetInput {
  targetStrain: number;
  zone: TodayPlanZone;
  explanation: string;
  readinessScore: number;
  workloadRatio: number | null;
}

export interface BuildTodayPlanInput {
  endDate: string;
  strainTarget: TodayPlanStrainTargetInput | null;
  sleepPerformanceScore: number | null;
  sleepPerformanceTier: TodayPlanSleepTier | null;
  recoveryDate: string | null;
  sleepDate: string | null;
}

export type TodayPlanResult =
  | {
      status: "ready";
      date: string;
      action: TodayPlanAction;
      supportingFacts: [TodayPlanSupportingFact, TodayPlanSupportingFact];
      /** Server-authored limitations that qualify the action's observations. */
      caveats: string[];
      confidence: TodayPlanConfidence;
      freshness: TodayPlanFreshness;
      missingInputs: string[];
      message?: undefined;
    }
  | {
      status: "insufficient_data";
      date: string;
      action: null;
      supportingFacts: [];
      confidence: "low";
      freshness: TodayPlanFreshness;
      missingInputs: string[];
      message: string;
    };

function daysBetween(laterDate: string, earlierDate: string): number {
  return Math.floor(
    (new Date(`${laterDate}T00:00:00Z`).getTime() -
      new Date(`${earlierDate}T00:00:00Z`).getTime()) /
      86400000,
  );
}

function resolveConfidence(
  endDate: string,
  recoveryDate: string | null,
  sleepDate: string | null,
): TodayPlanConfidence {
  if (recoveryDate == null) return "low";
  const recoveryAgeDays = daysBetween(endDate, recoveryDate);
  if (recoveryAgeDays > 1) return "low";
  if (recoveryAgeDays === 0 && sleepDate != null && daysBetween(endDate, sleepDate) <= 1) {
    return "high";
  }
  return "moderate";
}

function actionTitle(zone: TodayPlanZone, targetStrain: number): string {
  if (zone === "Push") return `Train hard today — aim for ${targetStrain} strain`;
  if (zone === "Recovery") return `Keep training light today — aim for ${targetStrain} strain`;
  return `No change needs attention — aim for ${targetStrain} strain`;
}

function secondSupportingFact(input: BuildTodayPlanInput): {
  fact: TodayPlanSupportingFact;
  missingSleep: boolean;
} {
  if (input.sleepPerformanceScore != null && input.sleepPerformanceTier != null) {
    return {
      fact: {
        label: "Sleep performance",
        value: `${input.sleepPerformanceScore} (${input.sleepPerformanceTier})`,
      },
      missingSleep: false,
    };
  }

  if (input.strainTarget?.workloadRatio != null) {
    return {
      fact: {
        label: "Recent-to-baseline workload ratio",
        value: String(input.strainTarget.workloadRatio),
      },
      missingSleep: true,
    };
  }

  return {
    fact: {
      label: "Strain target",
      value: String(input.strainTarget?.targetStrain ?? 0),
    },
    missingSleep: true,
  };
}

function buildCaveats(input: BuildTodayPlanInput, missingSleep: boolean): string[] {
  const caveats: string[] = [];

  if (missingSleep) {
    if (input.strainTarget?.workloadRatio == null) {
      caveats.push(
        "Sleep and recent workload data were unavailable, so this plan uses recovery and the strain target.",
      );
    } else {
      caveats.push(
        "Sleep performance was unavailable, so this plan uses recovery and recent workload instead.",
      );
    }
  }

  if (input.recoveryDate == null) {
    caveats.push("Recovery data has no date, so confidence is low.");
  } else if (daysBetween(input.endDate, input.recoveryDate) > 0) {
    caveats.push(`Recovery data is from ${input.recoveryDate}, so this plan may be less current.`);
  }

  if (input.sleepDate != null && daysBetween(input.endDate, input.sleepDate) > 0) {
    caveats.push(`Sleep data is from ${input.sleepDate}, so it may not reflect the latest night.`);
  }

  return caveats;
}

/**
 * Build a deterministic Today Plan from already-computed recovery/strain inputs.
 * Clients must render this payload and must not recompute health meaning.
 */
export function buildTodayPlan(input: BuildTodayPlanInput): TodayPlanResult {
  const freshness: TodayPlanFreshness = {
    recoveryDate: input.recoveryDate,
    sleepDate: input.sleepDate,
  };

  if (input.strainTarget == null) {
    return {
      status: "insufficient_data",
      date: input.endDate,
      action: null,
      supportingFacts: [],
      confidence: "low",
      freshness,
      missingInputs: ["recovery"],
      message:
        "Connect a recovery source and wait for today's recovery score before a training plan can be generated.",
    };
  }

  const { fact: secondFact, missingSleep } = secondSupportingFact(input);
  const missingInputs = missingSleep ? ["sleep"] : [];

  return {
    status: "ready",
    date: input.endDate,
    action: {
      id: "strain_target",
      title: actionTitle(input.strainTarget.zone, input.strainTarget.targetStrain),
      summary: input.strainTarget.explanation,
      zone: input.strainTarget.zone,
    },
    supportingFacts: [
      {
        label: "Recovery",
        value: `${input.strainTarget.readinessScore}/100`,
      },
      secondFact,
    ],
    caveats: buildCaveats(input, missingSleep),
    confidence: resolveConfidence(input.endDate, input.recoveryDate, input.sleepDate),
    freshness,
    missingInputs,
  };
}

const confidenceLabels: Record<TodayPlanConfidence, string> = {
  high: "High confidence",
  moderate: "Moderate confidence",
  low: "Low confidence",
};

/**
 * Shared confidence wording for web and mobile Today Plan cards.
 */
export function formatTodayPlanConfidence(confidence: TodayPlanConfidence): string {
  return confidenceLabels[confidence];
}

/**
 * Shared freshness wording for web and mobile Today Plan cards.
 */
export function formatTodayPlanFreshness(freshness: TodayPlanFreshness): string | null {
  const parts: string[] = [];
  if (freshness.recoveryDate != null) {
    parts.push(`Recovery data from ${freshness.recoveryDate}`);
  }
  if (freshness.sleepDate != null) {
    parts.push(`Sleep data from ${freshness.sleepDate}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
