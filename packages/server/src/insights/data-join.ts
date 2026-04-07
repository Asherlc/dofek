import type {
  ActivityRow,
  BodyCompRow,
  DailyRow,
  InsightsConfig,
  NutritionRow,
  SleepRow,
} from "./types.ts";

// ── Date normalization helper ─────────────────────────────────────────────

function toDateStr(d: string | Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// ── Join data by date ─────────────────────────────────────────────────────

export interface JoinedDay {
  date: string;
  // metrics
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  skin_temp_c: number | null;
  // sleep (night before → this date)
  sleep_duration_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  sleep_efficiency: number | null;
  // activity on this date
  exercise_minutes: number | null;
  cardio_minutes: number | null;
  strength_minutes: number | null;
  flexibility_minutes: number | null;
  // nutrition
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  // body comp (daily, pick closest measurement)
  weight_kg: number | null;
  body_fat_pct: number | null;
  // rolling body comp (30-day trailing)
  weight_30d_avg: number | null;
  body_fat_30d_avg: number | null;
  weight_30d_delta: number | null;
  body_fat_30d_delta: number | null;
}

export function classifyActivity(type: string): "cardio" | "strength" | "flexibility" | "other" {
  const typeLower = type.toLowerCase();
  if (
    [
      "cycling",
      "walking",
      "hiking",
      "running",
      "swimming",
      "cross_country_skiing",
      "downhill_skiing",
      "cardio",
      "cross_training",
      "tennis",
      "climbing",
    ].includes(typeLower)
  )
    return "cardio";
  if (["strength_training", "functional_strength", "strength"].includes(typeLower))
    return "strength";
  if (["yoga", "stretching", "preparation_and_recovery"].includes(typeLower)) return "flexibility";
  return "other";
}

export function joinByDate(
  metrics: DailyRow[],
  sleep: SleepRow[],
  activities: ActivityRow[],
  nutrition: NutritionRow[],
  bodyComp: BodyCompRow[],
  config: InsightsConfig,
): JoinedDay[] {
  const metricsByDate = new Map(metrics.map((m) => [toDateStr(m.date), m]));

  // Sleep: assign to the date the person woke up
  const sleepByWakeDate = new Map<string, SleepRow>();
  for (const s of sleep) {
    if (s.is_nap) continue;
    const wakeDate = new Date(s.started_at);
    if (s.duration_minutes) {
      wakeDate.setMinutes(wakeDate.getMinutes() + s.duration_minutes);
    }
    const dateStr = wakeDate.toISOString().slice(0, 10);
    const existing = sleepByWakeDate.get(dateStr);
    if (!existing || (s.duration_minutes ?? 0) > (existing.duration_minutes ?? 0)) {
      sleepByWakeDate.set(dateStr, s);
    }
  }

  // Activities: sum duration per date, broken down by category
  const activityByDate = new Map<
    string,
    { minutes: number; cardio: number; strength: number; flexibility: number }
  >();
  for (const a of activities) {
    const dateStr = new Date(a.started_at).toISOString().slice(0, 10);
    const existing = activityByDate.get(dateStr) ?? {
      minutes: 0,
      cardio: 0,
      strength: 0,
      flexibility: 0,
    };
    if (a.ended_at) {
      const dur = (new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) / 60000;
      existing.minutes += dur;
      const cat = classifyActivity(a.activity_type);
      if (cat === "cardio") existing.cardio += dur;
      else if (cat === "strength") existing.strength += dur;
      else if (cat === "flexibility") existing.flexibility += dur;
    }
    activityByDate.set(dateStr, existing);
  }

  // Nutrition by date — filter out incomplete tracking days
  const completeNutrition = nutrition.filter((n) => (n.calories ?? 0) >= config.minDailyCalories);
  const nutritionByDate = new Map(completeNutrition.map((n) => [toDateStr(n.date), n]));

  // Body comp: one measurement per date (latest if multiple)
  const bodyCompByDate = new Map<string, BodyCompRow>();
  for (const b of bodyComp) {
    const dateStr = new Date(b.recorded_at).toISOString().slice(0, 10);
    bodyCompByDate.set(dateStr, b); // last wins (data sorted ASC)
  }

  const joined: JoinedDay[] = [];
  for (const [date, m] of metricsByDate) {
    const sleepRow = sleepByWakeDate.get(date);
    const activityRow = activityByDate.get(date);
    const nutritionRow = nutritionByDate.get(date);
    const bc = bodyCompByDate.get(date);
    joined.push({
      date,
      resting_hr: m.resting_hr,
      hrv: m.hrv,
      spo2_avg: m.spo2_avg,
      steps: m.steps,
      active_energy_kcal: m.active_energy_kcal,
      skin_temp_c: m.skin_temp_c,
      sleep_duration_min: sleepRow?.duration_minutes ?? null,
      deep_min: sleepRow?.deep_minutes ?? null,
      rem_min: sleepRow?.rem_minutes ?? null,
      sleep_efficiency: sleepRow?.efficiency_pct ?? null,
      exercise_minutes: activityRow?.minutes ?? null,
      cardio_minutes: activityRow?.cardio ?? null,
      strength_minutes: activityRow?.strength ?? null,
      flexibility_minutes: activityRow?.flexibility ?? null,
      calories: nutritionRow?.calories ?? null,
      protein_g: nutritionRow?.protein_g ?? null,
      carbs_g: nutritionRow?.carbs_g ?? null,
      fat_g: nutritionRow?.fat_g ?? null,
      fiber_g: nutritionRow?.fiber_g ?? null,
      weight_kg: bc?.weight_kg ?? null,
      body_fat_pct: bc?.body_fat_pct ?? null,
      // rolling values computed below
      weight_30d_avg: null,
      body_fat_30d_avg: null,
      weight_30d_delta: null,
      body_fat_30d_delta: null,
    });
  }

  joined.sort((a, b) => a.date.localeCompare(b.date));

  // Compute rolling averages and deltas for body comp
  // Use 30-day windows — weight trends are weekly/monthly, not daily
  const BODY_WINDOW = 30;
  for (let i = 0; i < joined.length; i++) {
    if (i < BODY_WINDOW - 1) continue;
    const window = joined.slice(i - (BODY_WINDOW - 1), i + 1);
    const weights = window.map((d) => d.weight_kg).filter((v): v is number => v != null);
    const fats = window.map((d) => d.body_fat_pct).filter((v): v is number => v != null);

    const day = joined[i];
    if (!day) continue;

    if (weights.length >= 5) {
      day.weight_30d_avg = weights.reduce((a, b) => a + b, 0) / weights.length;
    }
    if (fats.length >= 5) {
      day.body_fat_30d_avg = fats.reduce((a, b) => a + b, 0) / fats.length;
    }

    // Delta: compare this 30-day avg to previous 30-day avg
    if (i >= BODY_WINDOW * 2 - 1) {
      const prevWindow = joined.slice(i - (BODY_WINDOW * 2 - 1), i - (BODY_WINDOW - 1));
      const prevWeights = prevWindow.map((d) => d.weight_kg).filter((v): v is number => v != null);
      const prevFats = prevWindow.map((d) => d.body_fat_pct).filter((v): v is number => v != null);

      if (weights.length >= 5 && prevWeights.length >= 5) {
        const curAvg = weights.reduce((a, b) => a + b, 0) / weights.length;
        const prevAvg = prevWeights.reduce((a, b) => a + b, 0) / prevWeights.length;
        day.weight_30d_delta = curAvg - prevAvg;
      }
      if (fats.length >= 5 && prevFats.length >= 5) {
        const curAvg = fats.reduce((a, b) => a + b, 0) / fats.length;
        const prevAvg = prevFats.reduce((a, b) => a + b, 0) / prevFats.length;
        day.body_fat_30d_delta = curAvg - prevAvg;
      }
    }
  }

  return joined;
}

// ── Rolling average helper ────────────────────────────────────────────────

export function rollingAvg(
  joined: JoinedDay[],
  idx: number,
  days: number,
  extract: (d: JoinedDay) => number | null,
  minCount?: number,
): number | null {
  if (idx < days - 1) return null;
  const window = joined.slice(idx - (days - 1), idx + 1);
  const vals = window.map(extract).filter((v): v is number => v != null);
  const required = minCount ?? Math.max(3, Math.ceil(days * 0.1));
  if (vals.length < required) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
