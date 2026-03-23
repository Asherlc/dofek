/**
 * Next workout recommendation engine.
 *
 * Pure function: takes a snapshot of the user's training state and returns
 * an evidence-based recommendation for what to do next.
 *
 * Based on:
 * - Polarized training model (Seiler, Stoggl & Sperlich 2014): 80/20 zone split
 * - Muscle group recovery (Schoenfeld 2016): 48h+ per group, 2x/week target
 * - HRV-guided training (Plews 2013): modulate intensity by recovery
 * - Hard/easy alternation (Seiler 2010): never stack high-intensity days
 * - HIIT capping: max 2-3x/week with 48h spacing
 */

import { computeHrRange as computeHrRangeFromZones } from "@dofek/zones/zones";

// ── Types ────────────────────────────────────────────────────────────

export type WorkoutType =
  | "rest"
  | "active_recovery"
  | "cardio_easy"
  | "cardio_intervals"
  | "strength";

export interface IntervalProtocol {
  name: string;
  description: string;
  workSeconds: number;
  restSeconds: number;
  sets: number;
  targetZone: number;
  warmupMinutes: number;
  cooldownMinutes: number;
  totalMinutes: number;
}

export interface StrengthDetail {
  muscleGroups: string[];
  estimatedDurationMinutes: number;
}

export interface CardioEasyDetail {
  targetZone: 1 | 2;
  durationMinutes: number;
  targetHrRange: { min: number; max: number } | null;
}

export interface CardioIntervalsDetail {
  protocol: IntervalProtocol;
  targetHrRange: { min: number; max: number } | null;
}

export interface WorkoutRecommendation {
  type: WorkoutType;
  summary: string;
  reasoning: string[];
  strengthDetail: StrengthDetail | null;
  cardioEasyDetail: CardioEasyDetail | null;
  cardioIntervalsDetail: CardioIntervalsDetail | null;
}

// ── Input ────────────────────────────────────────────────────────────

export interface RecentActivity {
  type: "strength" | "cardio";
  date: string; // ISO date (YYYY-MM-DD)
  wasHardDay: boolean;
  muscleGroups: string[];
  activityType: string;
}

export interface ZoneDistribution {
  zone1Samples: number;
  zone2Samples: number;
  zone3Samples: number;
  zone4Samples: number;
  zone5Samples: number;
}

export interface MuscleGroupFreshness {
  muscleGroup: string;
  lastWorkedDate: string; // ISO date
  setsThisWeek: number;
}

export interface RecommendationInput {
  today: string; // ISO date (YYYY-MM-DD)
  readinessScore: number | null; // 0-100, null if insufficient data
  workloadRatio: number | null; // ACWR
  trainingStressBalance: number | null; // TSB
  sleepDebtMinutes: number;
  recentActivities: RecentActivity[]; // last 14 days, newest first
  zoneDistribution: ZoneDistribution | null; // current week
  muscleGroupFreshness: MuscleGroupFreshness[];
  userMaxHr: number | null;
  userRestingHr: number | null;
}

// ── Constants ────────────────────────────────────────────────────────

const MUSCLE_RECOVERY_HOURS = 48;
const HIIT_SPACING_DAYS = 2;
const MAX_HIIT_PER_WEEK = 3;

/** Target: ≤20% of endurance time in zones 4+5 (polarized 80/20 model) */
const HIGH_INTENSITY_RATIO_TARGET = 0.2;

/** Readiness thresholds */
const READINESS_REST = 33;
const READINESS_EASY = 50;
const READINESS_MODERATE = 65;

/** Grouping of muscle groups into training sessions */
const UPPER_PUSH = ["chest", "shoulders", "triceps"];
const UPPER_PULL = ["back", "biceps", "lats", "traps"];
const LOWER_BODY = ["quadriceps", "hamstrings", "glutes", "calves", "legs"];
const CORE = ["core", "abs", "obliques"];

const MUSCLE_GROUP_LABELS: Record<string, string> = {
  chest: "Chest",
  shoulders: "Shoulders",
  triceps: "Triceps",
  back: "Back",
  biceps: "Biceps",
  lats: "Lats",
  traps: "Traps",
  quadriceps: "Quads",
  hamstrings: "Hamstrings",
  glutes: "Glutes",
  calves: "Calves",
  legs: "Legs",
  core: "Core",
  abs: "Abs",
  obliques: "Obliques",
  forearms: "Forearms",
};

export function muscleGroupLabel(group: string): string {
  return MUSCLE_GROUP_LABELS[group] ?? group.charAt(0).toUpperCase() + group.slice(1);
}

// ── Interval Protocols ───────────────────────────────────────────────

const NORWEGIAN_4X4: IntervalProtocol = {
  name: "Norwegian 4x4",
  description: "4 min hard, 3 min easy recovery. Best for building aerobic power.",
  workSeconds: 240,
  restSeconds: 180,
  sets: 4,
  targetZone: 4,
  warmupMinutes: 10,
  cooldownMinutes: 10,
  totalMinutes: 48,
};

const BILLAT_30_30: IntervalProtocol = {
  name: "30/30 Intervals",
  description: "30 sec hard, 30 sec easy. Accumulates time near peak aerobic capacity efficiently.",
  workSeconds: 30,
  restSeconds: 30,
  sets: 20,
  targetZone: 5,
  warmupMinutes: 10,
  cooldownMinutes: 10,
  totalMinutes: 40,
};

// ── Core Algorithm ───────────────────────────────────────────────────

export function recommendNextWorkout(input: RecommendationInput): WorkoutRecommendation {
  const reasoning: string[] = [];

  // Step 1: Check readiness — gate intensity
  if (input.readinessScore != null && input.readinessScore < READINESS_REST) {
    reasoning.push(`Recovery score is ${input.readinessScore}/100 — your body needs rest`);
    if (input.sleepDebtMinutes > 120) {
      reasoning.push(
        `Sleep debt is ${Math.round(input.sleepDebtMinutes / 60)} hours — prioritize sleep`,
      );
    }
    return makeRest(reasoning);
  }

  if (input.readinessScore != null && input.readinessScore < READINESS_EASY) {
    reasoning.push(`Recovery score is ${input.readinessScore}/100 — keep it light today`);
    return makeActiveRecovery(reasoning);
  }

  // Step 2: Check workload ratio for injury risk
  if (input.workloadRatio != null && input.workloadRatio > 1.5) {
    reasoning.push(`Workload ratio is ${input.workloadRatio.toFixed(2)} — high injury risk zone`);
    return makeActiveRecovery(reasoning);
  }

  // Step 3: Hard/easy alternation — was yesterday hard?
  const yesterdayWasHard = wasYesterdayHard(input);
  const isModerateReadiness =
    input.readinessScore != null && input.readinessScore < READINESS_MODERATE;

  if (yesterdayWasHard && isModerateReadiness) {
    reasoning.push("Yesterday was a hard training day and recovery is moderate");
    return makeCardioEasy(input, reasoning);
  }

  // Step 4: Decide between strength and cardio
  const daysSinceStrength = daysSinceActivityType(input, "strength");
  const daysSinceCardio = daysSinceActivityType(input, "cardio");
  const freshMuscleGroups = getFreshMuscleGroups(input);
  const hiitCountThisWeek = countHiitThisWeek(input);

  // Strength is overdue (3+ days) and muscle groups are available
  if (daysSinceStrength >= 3 && freshMuscleGroups.length > 0) {
    reasoning.push(
      `Last strength workout was ${daysSinceStrength === Infinity ? "over a week" : `${daysSinceStrength} days`} ago`,
    );
    return makeStrength(freshMuscleGroups, reasoning);
  }

  // Cardio is overdue
  if (daysSinceCardio >= 2) {
    reasoning.push(
      `Last cardio session was ${daysSinceCardio === Infinity ? "over a week" : `${daysSinceCardio} days`} ago`,
    );
    return decideCardioIntensity(input, hiitCountThisWeek, yesterdayWasHard, reasoning);
  }

  // Neither is overdue — alternate based on last activity
  const lastActivity = input.recentActivities[0];
  if (lastActivity?.type === "cardio" && freshMuscleGroups.length > 0) {
    reasoning.push("Alternating from yesterday's cardio session");
    return makeStrength(freshMuscleGroups, reasoning);
  }

  if (lastActivity?.type === "strength") {
    reasoning.push("Alternating from yesterday's strength session");
    return decideCardioIntensity(input, hiitCountThisWeek, yesterdayWasHard, reasoning);
  }

  // Default: check what's most needed
  if (freshMuscleGroups.length > 0 && daysSinceStrength >= daysSinceCardio) {
    reasoning.push("Balancing weekly training between strength and cardio");
    return makeStrength(freshMuscleGroups, reasoning);
  }

  return decideCardioIntensity(input, hiitCountThisWeek, yesterdayWasHard, reasoning);
}

// ── Helpers ──────────────────────────────────────────────────────────

function wasYesterdayHard(input: RecommendationInput): boolean {
  const yesterday = addDays(input.today, -1);
  return input.recentActivities.some((a) => a.date === yesterday && a.wasHardDay);
}

function daysSinceActivityType(input: RecommendationInput, type: "strength" | "cardio"): number {
  const activity = input.recentActivities.find((a) => a.type === type);
  if (!activity) return Number.POSITIVE_INFINITY;
  return daysBetween(activity.date, input.today);
}

function getFreshMuscleGroups(input: RecommendationInput): string[] {
  const hoursThreshold = MUSCLE_RECOVERY_HOURS;
  const todayDate = new Date(input.today);

  return input.muscleGroupFreshness
    .filter((mg) => {
      const lastWorked = new Date(mg.lastWorkedDate);
      const hoursSince = (todayDate.getTime() - lastWorked.getTime()) / (1000 * 60 * 60);
      return hoursSince >= hoursThreshold;
    })
    .map((mg) => mg.muscleGroup);
}

function countHiitThisWeek(input: RecommendationInput): number {
  // Count hard cardio sessions in the last 7 days
  const weekAgo = addDays(input.today, -7);
  return input.recentActivities.filter(
    (a) => a.type === "cardio" && a.wasHardDay && a.date > weekAgo,
  ).length;
}

function daysSinceLastHiit(input: RecommendationInput): number {
  const lastHiit = input.recentActivities.find((a) => a.type === "cardio" && a.wasHardDay);
  if (!lastHiit) return Number.POSITIVE_INFINITY;
  return daysBetween(lastHiit.date, input.today);
}

function getHighIntensityRatio(zone: ZoneDistribution): number {
  const total =
    zone.zone1Samples +
    zone.zone2Samples +
    zone.zone3Samples +
    zone.zone4Samples +
    zone.zone5Samples;
  if (total === 0) return 0;
  return (zone.zone4Samples + zone.zone5Samples) / total;
}

function decideCardioIntensity(
  input: RecommendationInput,
  hiitCountThisWeek: number,
  yesterdayWasHard: boolean,
  reasoning: string[],
): WorkoutRecommendation {
  const canDoHiit =
    hiitCountThisWeek < MAX_HIIT_PER_WEEK &&
    daysSinceLastHiit(input) >= HIIT_SPACING_DAYS &&
    !yesterdayWasHard;

  // Check if zone distribution allows more high intensity
  const needsMoreHighIntensity =
    input.zoneDistribution != null &&
    getHighIntensityRatio(input.zoneDistribution) < HIGH_INTENSITY_RATIO_TARGET;

  // Strong readiness + room for HIIT = intervals
  const goodReadiness = input.readinessScore == null || input.readinessScore >= READINESS_MODERATE;
  const positiveTsb = input.trainingStressBalance == null || input.trainingStressBalance > -10;

  if (canDoHiit && (needsMoreHighIntensity || positiveTsb) && goodReadiness) {
    reasoning.push("Recovery is good and zone distribution supports a hard session");
    if (hiitCountThisWeek > 0) {
      reasoning.push(
        `${hiitCountThisWeek} hard cardio session${hiitCountThisWeek > 1 ? "s" : ""} already this week (max ${MAX_HIIT_PER_WEEK})`,
      );
    }
    return makeCardioIntervals(input, reasoning);
  }

  if (!canDoHiit) {
    if (hiitCountThisWeek >= MAX_HIIT_PER_WEEK) {
      reasoning.push(`Already hit ${MAX_HIIT_PER_WEEK} hard cardio sessions this week`);
    } else if (daysSinceLastHiit(input) < HIIT_SPACING_DAYS) {
      reasoning.push("Need 48 hours between hard cardio sessions");
    } else if (yesterdayWasHard) {
      reasoning.push("Yesterday was a hard session — keeping today easy");
    }
  }

  return makeCardioEasy(input, reasoning);
}

function selectIntervalProtocol(input: RecommendationInput): IntervalProtocol {
  // If TSB is very positive (fresh), go for the harder protocol
  if (input.trainingStressBalance != null && input.trainingStressBalance > 5) {
    return NORWEGIAN_4X4;
  }

  // If high-intensity ratio is very low, use 30/30s to build it up quickly
  if (input.zoneDistribution != null && getHighIntensityRatio(input.zoneDistribution) < 0.1) {
    return BILLAT_30_30;
  }

  // Default to Norwegian 4x4 as the gold standard
  return NORWEGIAN_4X4;
}

function computeHrRange(
  input: RecommendationInput,
  zone: number,
): { min: number; max: number } | null {
  return computeHrRangeFromZones(input.userMaxHr, input.userRestingHr, zone);
}

function pickMuscleGroupFocus(freshGroups: string[]): string[] {
  // Prefer training muscle groups that form a natural session
  const upperPush = freshGroups.filter((g) => UPPER_PUSH.includes(g));
  const upperPull = freshGroups.filter((g) => UPPER_PULL.includes(g));
  const lower = freshGroups.filter((g) => LOWER_BODY.includes(g));
  const core = freshGroups.filter((g) => CORE.includes(g));

  // Pick the group with the most available muscles
  const groups = [
    { label: "push", muscles: upperPush },
    { label: "pull", muscles: upperPull },
    { label: "lower", muscles: lower },
  ].sort((a, b) => b.muscles.length - a.muscles.length);

  const best = groups[0];
  if (best && best.muscles.length > 0) {
    // Add core if fresh
    return [...best.muscles, ...core];
  }

  // Fallback: return all fresh groups
  return freshGroups;
}

function muscleGroupSummary(groups: string[]): string {
  const withoutCore = groups.filter((g) => !CORE.includes(g));

  if (withoutCore.every((g) => UPPER_PUSH.includes(g))) return "Upper Body Push";
  if (withoutCore.every((g) => UPPER_PULL.includes(g))) return "Upper Body Pull";
  if (withoutCore.every((g) => LOWER_BODY.includes(g))) return "Lower Body";
  if (withoutCore.length === 0 && groups.length > 0) return "Core";

  return groups.map(muscleGroupLabel).slice(0, 3).join(", ");
}

// ── Builders ─────────────────────────────────────────────────────────

function makeRest(reasoning: string[]): WorkoutRecommendation {
  return {
    type: "rest",
    summary: "Rest Day",
    reasoning,
    strengthDetail: null,
    cardioEasyDetail: null,
    cardioIntervalsDetail: null,
  };
}

function makeActiveRecovery(reasoning: string[]): WorkoutRecommendation {
  reasoning.push("Light movement promotes blood flow and recovery");
  return {
    type: "active_recovery",
    summary: "Active Recovery — Easy Walk or Mobility",
    reasoning,
    strengthDetail: null,
    cardioEasyDetail: {
      targetZone: 1,
      durationMinutes: 30,
      targetHrRange: null,
    },
    cardioIntervalsDetail: null,
  };
}

function makeCardioEasy(input: RecommendationInput, reasoning: string[]): WorkoutRecommendation {
  reasoning.push("Zone 2 aerobic base building — conversational pace");
  const hrRange = computeHrRange(input, 2);
  return {
    type: "cardio_easy",
    summary: "Easy Cardio — Zone 2 Aerobic Base",
    reasoning,
    strengthDetail: null,
    cardioEasyDetail: {
      targetZone: 2,
      durationMinutes: 45,
      targetHrRange: hrRange,
    },
    cardioIntervalsDetail: null,
  };
}

function makeCardioIntervals(
  input: RecommendationInput,
  reasoning: string[],
): WorkoutRecommendation {
  const protocol = selectIntervalProtocol(input);
  reasoning.push(`${protocol.name}: ${protocol.description}`);
  const hrRange = computeHrRange(input, protocol.targetZone);
  return {
    type: "cardio_intervals",
    summary: `Cardio Intervals — ${protocol.name}`,
    reasoning,
    strengthDetail: null,
    cardioEasyDetail: null,
    cardioIntervalsDetail: {
      protocol,
      targetHrRange: hrRange,
    },
  };
}

function makeStrength(freshMuscleGroups: string[], reasoning: string[]): WorkoutRecommendation {
  const focus = pickMuscleGroupFocus(freshMuscleGroups);
  const label = muscleGroupSummary(focus);
  reasoning.push(`Muscle groups ready: ${focus.map(muscleGroupLabel).join(", ")}`);

  return {
    type: "strength",
    summary: `Strength — ${label}`,
    reasoning,
    strengthDetail: {
      muscleGroups: focus,
      estimatedDurationMinutes: 45 + focus.length * 5,
    },
    cardioEasyDetail: null,
    cardioIntervalsDetail: null,
  };
}

// ── Date Helpers ─────────────────────────────────────────────────────

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0] ?? isoDate;
}

function daysBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
