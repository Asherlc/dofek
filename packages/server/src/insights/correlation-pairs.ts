import type { JoinedDay } from "./data-join.ts";
import { rollingAvg } from "./data-join.ts";

// ── Correlation pairs ─────────────────────────────────────────────────────

export interface CorrelationPair {
  id: string;
  xName: string;
  yName: string;
  xFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
  yFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

export function getCorrelationPairs(): CorrelationPair[] {
  return [
    // ── Sleep/recovery ──
    {
      id: "sleep-dur-hrv",
      xName: "sleep duration",
      yName: "next-day HRV",
      xFn: (d) => d.sleep_duration_min,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "steps-hrv",
      xName: "daily steps",
      yName: "next-day HRV",
      xFn: (d) => d.steps,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "active-kcal-sleep",
      xName: "active calories",
      yName: "sleep duration that night",
      xFn: (d) => d.active_energy_kcal,
      yFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "deep-sleep-hrv",
      xName: "deep sleep",
      yName: "next-day HRV",
      xFn: (d) => d.deep_min,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "exercise-dur-sleep-eff",
      xName: "exercise duration",
      yName: "sleep efficiency",
      xFn: (d) => d.exercise_minutes,
      yFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    // ── Nutrition → body comp (30-day rolling, isocaloric: use % of calories) ──
    {
      id: "calories-30d-weight-delta",
      xName: "30-day avg calories",
      yName: "monthly weight change",
      xFn: (_d, all, i) => rollingAvg(all, i, 30, (r) => r.calories),
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "protein-pct-30d-weight-delta",
      xName: "30-day avg protein %",
      yName: "monthly weight change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.protein_g != null && r.calories ? ((r.protein_g * 4) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "protein-pct-30d-bf-delta",
      xName: "30-day avg protein %",
      yName: "monthly body fat change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.protein_g != null && r.calories ? ((r.protein_g * 4) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.body_fat_30d_delta,
    },
    {
      id: "carb-pct-30d-weight-delta",
      xName: "30-day avg carb %",
      yName: "monthly weight change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.carbs_g != null && r.calories ? ((r.carbs_g * 4) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "fat-pct-30d-bf-delta",
      xName: "30-day avg fat %",
      yName: "monthly body fat change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.fat_g != null && r.calories ? ((r.fat_g * 9) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.body_fat_30d_delta,
    },
    // ── Exercise → body comp (30-day rolling) ──
    {
      id: "exercise-30d-weight-delta",
      xName: "monthly exercise volume",
      yName: "monthly weight change",
      xFn: (_d: JoinedDay, all: JoinedDay[], i: number) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const total = month.reduce((sum, w) => sum + (w.exercise_minutes ?? 0), 0);
        return total > 0 ? total : null;
      },
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "exercise-30d-bf-delta",
      xName: "monthly exercise volume",
      yName: "monthly body fat change",
      xFn: (_d: JoinedDay, all: JoinedDay[], i: number) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const total = month.reduce((sum, w) => sum + (w.exercise_minutes ?? 0), 0);
        return total > 0 ? total : null;
      },
      yFn: (d) => d.body_fat_30d_delta,
    },
    // ── Nutrition → recovery ──
    {
      id: "protein-hrv",
      xName: "daily protein",
      yName: "next-day HRV",
      xFn: (d) => d.protein_g,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "calories-sleep",
      xName: "daily calories",
      yName: "sleep duration",
      xFn: (d) => d.calories,
      yFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
  ];
}
