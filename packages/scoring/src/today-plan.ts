import { type EpistemicStatus, getEpistemicStatus } from "./epistemic-status.ts";

export type TodayPlanZone = "Push" | "Maintain" | "Recovery";
export type TodayPlanSleepTier = "Excellent" | "Good" | "Fair" | "Poor";

export interface TodayPlanSupportingFact {
  label: string;
  value: string;
}

export interface TodayPlanAction {
  id: "strain_target";
  title: string;
  zone: TodayPlanZone;
}

export interface TodayPlanFreshness {
  recoveryDate: string | null;
  sleepDate: string | null;
}

export interface TodayPlanStrainTargetInput {
  targetStrain: number;
  zone: TodayPlanZone;
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
      epistemicStatus: EpistemicStatus;
      date: string;
      action: TodayPlanAction;
      supportingFacts: TodayPlanSupportingFact[];
      /** Server-authored limitations that qualify the action's observations. */
      caveats: string[];
      freshness: TodayPlanFreshness;
      missingInputs: string[];
      message?: undefined;
    }
  | {
      status: "insufficient_data";
      epistemicStatus: EpistemicStatus;
      date: string;
      action: null;
      supportingFacts: [];
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

function secondSupportingFact(input: BuildTodayPlanInput): {
  fact: TodayPlanSupportingFact | null;
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
    fact: null,
    missingSleep: true,
  };
}

function buildCaveats(input: BuildTodayPlanInput, missingSleep: boolean): string[] {
  const caveats: string[] = [];

  if (missingSleep) {
    if (input.strainTarget?.workloadRatio == null) {
      caveats.push(
        "Sleep and recent workload data were unavailable, so this suggestion uses recovery only.",
      );
    } else {
      caveats.push("Sleep performance was unavailable; recent workload is shown for context.");
    }
  }

  if (input.recoveryDate == null) {
    caveats.push("Recovery data has no date; its recency is unknown.");
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
      epistemicStatus: getEpistemicStatus("unavailable"),
      date: input.endDate,
      action: null,
      supportingFacts: [],
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
    epistemicStatus: getEpistemicStatus("suggested"),
    date: input.endDate,
    action: {
      id: "strain_target",
      title: `Suggested strain: ${input.strainTarget.targetStrain}`,
      zone: input.strainTarget.zone,
    },
    supportingFacts: [
      {
        label: "Recovery",
        value: `${input.strainTarget.readinessScore}/100`,
      },
      ...(secondFact ? [secondFact] : []),
    ],
    caveats: buildCaveats(input, missingSleep),
    freshness,
    missingInputs,
  };
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
