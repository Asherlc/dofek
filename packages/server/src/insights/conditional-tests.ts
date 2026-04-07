import type { JoinedDay } from "./data-join.ts";
import { rollingAvg } from "./data-join.ts";

// ── Conditional analysis ──────────────────────────────────────────────────

export interface ConditionalTest {
  id: string;
  action: string;
  metric: string;
  scope?: "day" | "month"; // default "day"
  splitFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => boolean | null;
  valueFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

export function getConditionalTests(): ConditionalTest[] {
  return [
    // ── Sleep → recovery ──
    {
      id: "sleep-7h-hrv",
      action: "7+ hours of sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.sleep_duration_min != null ? d.sleep_duration_min >= 420 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "sleep-7h-rhr",
      action: "7+ hours of sleep",
      metric: "next-day resting HR",
      splitFn: (d) => (d.sleep_duration_min != null ? d.sleep_duration_min >= 420 : null),
      valueFn: (_d, all, i) => all[i + 1]?.resting_hr ?? null,
    },
    {
      id: "deep-60-hrv",
      action: "60+ min deep sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.deep_min != null ? d.deep_min >= 60 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise → sleep/recovery ──
    {
      id: "exercise-30-sleep",
      action: "30+ min exercise",
      metric: "sleep duration that night",
      splitFn: (d) => (d.exercise_minutes != null ? d.exercise_minutes >= 30 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "exercise-30-hrv",
      action: "30+ min exercise",
      metric: "next-day HRV",
      splitFn: (d) => (d.exercise_minutes != null ? d.exercise_minutes >= 30 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "steps-10k-hrv",
      action: "10,000+ steps",
      metric: "next-day HRV",
      splitFn: (d) => (d.steps != null ? d.steps >= 10000 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "active-500-sleep-eff",
      action: "500+ active kcal",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.active_energy_kcal != null ? d.active_energy_kcal >= 500 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "sleep-consistent-hrv",
      action: "consistent sleep schedule (< 30min variation)",
      metric: "HRV",
      splitFn: (_d: JoinedDay, all: JoinedDay[], i: number) => {
        if (i < 7) return null;
        const week = all.slice(i - 6, i + 1);
        const durations = week
          .map((w) => w.sleep_duration_min)
          .filter((v): v is number => v != null);
        if (durations.length < 5) return null;
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const std = Math.sqrt(durations.reduce((s, v) => s + (v - avg) ** 2, 0) / durations.length);
        return std < 30;
      },
      valueFn: (d) => d.hrv,
    },
    {
      id: "rem-90-hrv",
      action: "90+ min REM sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.rem_min != null ? d.rem_min >= 90 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise type → sleep ──
    {
      id: "cardio-sleep",
      action: "cardio day",
      metric: "sleep duration that night",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "cardio-deep-sleep",
      action: "cardio day",
      metric: "deep sleep that night",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.deep_min ?? null,
    },
    {
      id: "cardio-sleep-eff",
      action: "cardio day",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "strength-sleep",
      action: "strength training day",
      metric: "sleep duration that night",
      splitFn: (d) => (d.strength_minutes != null ? d.strength_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "strength-deep-sleep",
      action: "strength training day",
      metric: "deep sleep that night",
      splitFn: (d) => (d.strength_minutes != null ? d.strength_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.deep_min ?? null,
    },
    {
      id: "yoga-sleep-eff",
      action: "yoga/flexibility day",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.flexibility_minutes != null ? d.flexibility_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "yoga-hrv",
      action: "yoga/flexibility day",
      metric: "next-day HRV",
      splitFn: (d) => (d.flexibility_minutes != null ? d.flexibility_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise type → recovery ──
    {
      id: "cardio-hrv",
      action: "cardio day",
      metric: "next-day HRV",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "strength-hrv",
      action: "strength training day",
      metric: "next-day HRV",
      splitFn: (d) => (d.strength_minutes != null ? d.strength_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise → body comp (30-day rolling) ──
    {
      id: "exercise-monthly-weight",
      action: "12+ exercise days per month",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const exerciseDays = month.filter((d) => (d.exercise_minutes ?? 0) >= 20).length;
        return exerciseDays >= 12;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "exercise-monthly-bf",
      action: "12+ exercise days per month",
      metric: "monthly body fat change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const exerciseDays = month.filter((d) => (d.exercise_minutes ?? 0) >= 20).length;
        return exerciseDays >= 12;
      },
      valueFn: (d) => d.body_fat_30d_delta,
    },
    // ── Nutrition → body comp (30-day rolling, isocaloric: use % of calories) ──
    {
      id: "high-cal-weight",
      action: "high calorie month (avg 2500+/day)",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) => d.calories);
        return avg != null ? avg >= 2500 : null;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "high-protein-pct-weight",
      action: ">30% calories from protein",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.protein_g != null && d.calories ? ((d.protein_g * 4) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 30 : null;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "high-protein-pct-bf",
      action: ">30% calories from protein",
      metric: "monthly body fat change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.protein_g != null && d.calories ? ((d.protein_g * 4) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 30 : null;
      },
      valueFn: (d) => d.body_fat_30d_delta,
    },
    {
      id: "high-carb-pct-weight",
      action: ">50% calories from carbs",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.carbs_g != null && d.calories ? ((d.carbs_g * 4) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 50 : null;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "high-fat-pct-bf",
      action: ">35% calories from fat",
      metric: "monthly body fat change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.fat_g != null && d.calories ? ((d.fat_g * 9) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 35 : null;
      },
      valueFn: (d) => d.body_fat_30d_delta,
    },
    // ── Nutrition → recovery ──
    {
      id: "high-protein-hrv",
      action: "100g+ protein",
      metric: "next-day HRV",
      splitFn: (d) => (d.protein_g != null ? d.protein_g >= 100 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "high-cal-sleep",
      action: "2500+ calories",
      metric: "sleep duration that night",
      splitFn: (d) => (d.calories != null ? d.calories >= 2500 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
  ];
}
