import { zScoreToRecoveryScore } from "@dofek/scoring/scoring";

interface RecommendationReadinessMetric {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  respiratory_rate: number | null;
  hrv_mean_30d: number | null;
  hrv_sd_30d: number | null;
  rhr_mean_30d: number | null;
  rhr_sd_30d: number | null;
  rr_mean_30d: number | null;
  rr_sd_30d: number | null;
}

interface RecommendationMuscleFreshness {
  muscle_group: string;
  last_trained_date: string;
}

export type ReadinessLevel = "low" | "moderate" | "high" | "unknown";
export type CardioFocus = "recovery" | "z2" | "intervals" | "hiit";

export function computeZonePercentages(zoneTotals: {
  zone0: number;
  zone1: number;
  zone2: number;
  zone3: number;
  zone4: number;
  zone5: number;
}): {
  totalZoneSamples: number;
  highIntensityPct: number;
  lowIntensityPct: number;
  moderateIntensityPct: number;
} {
  const totalZoneSamples =
    zoneTotals.zone0 +
    zoneTotals.zone1 +
    zoneTotals.zone2 +
    zoneTotals.zone3 +
    zoneTotals.zone4 +
    zoneTotals.zone5;
  const highIntensitySamples = zoneTotals.zone4 + zoneTotals.zone5;
  const moderateSamples = zoneTotals.zone3;
  const lowSamples = zoneTotals.zone0 + zoneTotals.zone1 + zoneTotals.zone2;
  const highIntensityPct = totalZoneSamples > 0 ? highIntensitySamples / totalZoneSamples : 0;
  const lowIntensityPct = totalZoneSamples > 0 ? lowSamples / totalZoneSamples : 0;
  const moderateIntensityPct = totalZoneSamples > 0 ? moderateSamples / totalZoneSamples : 0;
  return { totalZoneSamples, highIntensityPct, lowIntensityPct, moderateIntensityPct };
}

export function computeComponentScores(
  latestMetric: RecommendationReadinessMetric | null,
  latestSleepEfficiency: number | null,
): {
  hrvScore: number;
  restingHrScore: number;
  sleepScore: number;
  respiratoryRateScore: number;
} {
  let hrvScore = 62;
  if (
    latestMetric?.hrv != null &&
    latestMetric.hrv_mean_30d != null &&
    latestMetric.hrv_sd_30d != null &&
    latestMetric.hrv_sd_30d > 0
  ) {
    const hrvZ = (latestMetric.hrv - latestMetric.hrv_mean_30d) / latestMetric.hrv_sd_30d;
    hrvScore = zScoreToRecoveryScore(hrvZ);
  }

  let restingHrScore = 62;
  if (
    latestMetric?.resting_hr != null &&
    latestMetric.rhr_mean_30d != null &&
    latestMetric.rhr_sd_30d != null &&
    latestMetric.rhr_sd_30d > 0
  ) {
    const rhrZ = (latestMetric.resting_hr - latestMetric.rhr_mean_30d) / latestMetric.rhr_sd_30d;
    restingHrScore = zScoreToRecoveryScore(-rhrZ);
  }

  const sleepScore =
    latestSleepEfficiency != null
      ? Math.max(0, Math.min(100, Math.round(latestSleepEfficiency)))
      : 62;

  let respiratoryRateScore = 62;
  if (
    latestMetric?.respiratory_rate != null &&
    latestMetric.rr_mean_30d != null &&
    latestMetric.rr_sd_30d != null &&
    latestMetric.rr_sd_30d > 0
  ) {
    const rrZ = (latestMetric.respiratory_rate - latestMetric.rr_mean_30d) / latestMetric.rr_sd_30d;
    respiratoryRateScore = zScoreToRecoveryScore(-rrZ);
  }

  return { hrvScore, restingHrScore, sleepScore, respiratoryRateScore };
}

export function computeReadinessScore(
  scores: {
    hrvScore: number;
    restingHrScore: number;
    sleepScore: number;
    respiratoryRateScore: number;
  },
  weights: { hrv: number; restingHr: number; sleep: number; respiratoryRate: number },
  hasMetric: boolean,
): number | null {
  if (!hasMetric) return null;
  const raw =
    scores.hrvScore * weights.hrv +
    scores.restingHrScore * weights.restingHr +
    scores.sleepScore * weights.sleep +
    scores.respiratoryRateScore * weights.respiratoryRate;
  return Math.round(raw);
}

export function shouldDoStrengthToday(input: {
  strengthReady: boolean;
  strengthUnderTarget: boolean;
  cardioUnderTarget: boolean;
  lastStrengthDaysAgo: number | null;
  lastEnduranceDaysAgo: number | null;
}): boolean {
  return (
    input.strengthReady &&
    (input.strengthUnderTarget ||
      (!input.cardioUnderTarget &&
        (input.lastStrengthDaysAgo ?? 99) >= (input.lastEnduranceDaysAgo ?? 99)))
  );
}

export function computeFocusMuscles(
  muscleFreshness: RecommendationMuscleFreshness[],
  todayDate: string,
): string[] {
  const freshMuscles = muscleFreshness
    .map((row) => ({
      name: normalizeMuscleName(row.muscle_group),
      daysAgo: daysAgoFromDate(row.last_trained_date, todayDate),
    }))
    .filter((row): row is { name: string; daysAgo: number } => row.daysAgo != null)
    .sort((a, b) => b.daysAgo - a.daysAgo);
  const focusMuscles = [...new Set(freshMuscles.filter((m) => m.daysAgo >= 2).map((m) => m.name))];
  return (
    focusMuscles.length > 0 ? focusMuscles : [...new Set(freshMuscles.map((m) => m.name))]
  ).slice(0, 3);
}

export function getReadinessLevel(score: number | null): ReadinessLevel {
  if (score == null) return "unknown";
  if (score < 33) return "low";
  if (score < 65) return "moderate";
  return "high";
}

export function daysAgoFromDate(date: string | null, todayDate: string): number | null {
  if (!date) return null;
  const lhs = Date.parse(`${todayDate}T00:00:00Z`);
  const rhs = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(lhs) || Number.isNaN(rhs)) return null;
  return Math.max(0, Math.floor((lhs - rhs) / 86_400_000));
}

export function normalizeMuscleName(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim().toLowerCase();
  const aliases: Record<string, string> = {
    delts: "shoulders",
    lats: "back",
    "upper back": "back",
    "lower back": "core",
    abdominals: "core",
    abs: "core",
    obliques: "core",
    quads: "quadriceps",
  };
  return aliases[cleaned] ?? cleaned;
}

export function pickStrengthSplit(focusMuscles: string[]): string {
  if (focusMuscles.length === 0) return "Full-body strength";

  const lower = new Set(["legs", "quadriceps", "hamstrings", "glutes", "calves"]);
  const push = new Set(["chest", "shoulders", "triceps"]);
  const pull = new Set(["back", "biceps", "traps"]);
  const core = new Set(["core"]);

  let lowerCount = 0;
  let pushCount = 0;
  let pullCount = 0;
  let coreCount = 0;

  for (const muscle of focusMuscles) {
    if (lower.has(muscle)) lowerCount++;
    if (push.has(muscle)) pushCount++;
    if (pull.has(muscle)) pullCount++;
    if (core.has(muscle)) coreCount++;
  }

  if (lowerCount >= 2) return "Lower-body strength";
  if (pushCount > 0 && pullCount > 0) return "Upper-body push/pull";
  if (pushCount > pullCount) return "Upper-body push";
  if (pullCount > pushCount) return "Upper-body pull";
  if (coreCount > 0) return "Core + accessories";
  return "Full-body strength";
}

export function computeTrainingStreak(trainingDates: string[]): number {
  if (trainingDates.length === 0) return 0;
  const normalized = trainingDates
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter((d) => !Number.isNaN(d))
    .sort((a, b) => b - a);
  if (normalized.length === 0) return 0;

  let streak = 1;
  for (let i = 1; i < normalized.length; i++) {
    const current = normalized[i];
    const prev = normalized[i - 1];
    if (current == null || prev == null) continue;
    const deltaDays = Math.round((prev - current) / 86_400_000);
    if (deltaDays === 1) {
      streak++;
      continue;
    }
    if (deltaDays > 1) break;
  }
  return streak;
}

export function pickCardioFocus(input: {
  readinessLevel: ReadinessLevel;
  readinessScore: number | null;
  highIntensityPct: number;
  lowIntensityPct: number;
  moderateIntensityPct: number;
  totalZoneSamples: number;
  hiitCount7d: number;
  daysSinceLastHiit: number | null;
}): CardioFocus {
  if (input.readinessLevel === "low") return "recovery";
  if (input.readinessLevel === "moderate" || (input.readinessScore ?? 0) < 65) return "z2";
  if (input.totalZoneSamples === 0) return "z2";

  if (input.hiitCount7d >= 3) return "z2";
  if (input.daysSinceLastHiit != null && input.daysSinceLastHiit < 2) return "z2";

  if (input.highIntensityPct < 0.08 && input.lowIntensityPct > 0.75) return "hiit";
  if (input.highIntensityPct < 0.2 && input.lowIntensityPct > 0.6) return "intervals";
  return "z2";
}

export function cardioPlan(focus: CardioFocus): {
  title: string;
  shortBlurb: string;
  durationMinutes: number;
  targetZones: string[];
  structure: string;
  details: string[];
} {
  if (focus === "hiit") {
    return {
      title: "Cardio HIIT Session",
      shortBlurb: "Do a short HIIT session today: 8 x 30s hard (Z5) with 90s easy recovery.",
      durationMinutes: 35,
      targetZones: ["Z1", "Z5"],
      structure: "10 min warm-up, 8 x 30s Z5 / 90s easy, 8-10 min cool-down.",
      details: [
        "Warm up progressively for 10 minutes before your first rep.",
        "Hit Z5 on each 30-second effort; keep recoveries very easy.",
        "Stop the session early if power/pace drops sharply.",
      ],
    };
  }

  if (focus === "intervals") {
    return {
      title: "Cardio Intervals Session",
      shortBlurb: "Do threshold-style intervals: 4 x 4 min around Z4 with easy recoveries.",
      durationMinutes: 50,
      targetZones: ["Z2", "Z4"],
      structure: "15 min warm-up, 4 x 4 min Z4 with 3 min easy between reps, 10 min cool-down.",
      details: [
        "Keep each work rep controlled and repeatable, not all-out.",
        "Spin/jog easily between reps to keep quality high.",
        "If your readiness drops mid-session, reduce to 3 reps.",
      ],
    };
  }

  if (focus === "recovery") {
    return {
      title: "Easy Recovery Cardio",
      shortBlurb:
        "Keep cardio very easy today: Z1-only movement to promote circulation and recovery.",
      durationMinutes: 30,
      targetZones: ["Z1"],
      structure: "20-40 min easy walk, spin, or swim in Z1.",
      details: [
        "Keep breathing relaxed and conversational throughout.",
        "Add 5-10 minutes of mobility after the session.",
        "This should leave you feeling better than when you started.",
      ],
    };
  }

  return {
    title: "Aerobic Base Cardio",
    shortBlurb:
      "Do steady Z2 cardio for 45-60 min to build aerobic fitness without excess fatigue.",
    durationMinutes: 50,
    targetZones: ["Z2"],
    structure: "Continuous Z2 effort for 45-60 min at a conversational pace.",
    details: [
      "Keep effort steady and controlled in the aerobic zone.",
      "Fuel and hydrate as needed if you go beyond 60 minutes.",
      "Finish with a short cooldown and light mobility.",
    ],
  };
}
