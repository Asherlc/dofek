import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { trpc } from "../lib/trpc.ts";

export function PredictionsPage() {
  const [days, setDays] = useState(365);
  const prediction = trpc.predictions.hrvPrediction.useQuery({ days });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6">
        <div>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
            HRV Prediction
          </h2>
          <p className="text-xs text-zinc-600 mt-0.5">
            What controllable factors — sleep, exercise, nutrition — actually drive your HRV?
          </p>
        </div>

        {prediction.isLoading && <LoadingSkeleton />}

        {prediction.data === null && !prediction.isLoading && (
          <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
            Not enough data to train models. Need at least 20 days with HRV readings.
          </div>
        )}

        {prediction.data && (
          <>
            <TomorrowCard prediction={prediction.data.tomorrowPrediction} />
            <DiagnosticsBar diagnostics={prediction.data.diagnostics} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <FeatureImportanceChart importances={prediction.data.featureImportances} />
              <PredictionVsActualChart predictions={prediction.data.predictions} />
            </div>
            <ResidualTimelineChart predictions={prediction.data.predictions} />
          </>
        )}
      </main>
    </div>
  );
}

// ── Tomorrow's prediction card ─────────────────────────────────────────────

interface TomorrowPrediction {
  linear: number;
  tree: number;
}

function TomorrowCard({ prediction }: { prediction: TomorrowPrediction | null }) {
  if (!prediction) return null;

  const avg = (prediction.linear + prediction.tree) / 2;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">
        Tomorrow's HRV Prediction
      </p>
      <div className="flex items-baseline gap-6">
        <div>
          <span className="text-3xl font-bold text-emerald-400">{avg.toFixed(0)}</span>
          <span className="text-sm text-zinc-500 ml-1">ms</span>
        </div>
        <div className="flex gap-4 text-xs text-zinc-500">
          <span>
            Simple model: <span className="text-zinc-300">{prediction.linear.toFixed(1)}</span>
          </span>
          <span>
            Advanced model: <span className="text-zinc-300">{prediction.tree.toFixed(1)}</span>
          </span>
        </div>
      </div>
      <p className="text-[10px] text-zinc-600 mt-2">
        Average of two models — one captures straightforward trends, the other captures complex
        interactions between factors.
      </p>
    </div>
  );
}

// ── Model diagnostics bar ──────────────────────────────────────────────────

interface Diagnostics {
  linearRSquared: number;
  linearAdjustedRSquared: number;
  treeRSquared: number;
  crossValidatedRSquared: number;
  sampleCount: number;
  featureCount: number;
}

function formatAccuracy(r2: number): string {
  const pct = Math.max(0, r2 * 100);
  return `${pct.toFixed(0)}%`;
}

function DiagnosticsBar({ diagnostics }: { diagnostics: Diagnostics }) {
  const items = [
    {
      label: "Simple model accuracy",
      value: formatAccuracy(diagnostics.linearRSquared),
      tooltip: "How much of the day-to-day HRV variation the simple (linear) model explains",
    },
    {
      label: "Advanced model accuracy",
      value: formatAccuracy(diagnostics.treeRSquared),
      tooltip: "How much the advanced (tree) model explains on training data",
    },
    {
      label: "Real-world accuracy",
      value: formatAccuracy(diagnostics.crossValidatedRSquared),
      highlight: true,
      tooltip:
        "Tested on data the model hasn't seen — this is the most honest measure of how well it will predict future HRV",
    },
    {
      label: "Days of data",
      value: diagnostics.sampleCount.toString(),
    },
    {
      label: "Factors used",
      value: diagnostics.featureCount.toString(),
    },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
          title={item.tooltip}
        >
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{item.label}</p>
          <p
            className={`text-sm font-mono ${item.highlight ? "text-emerald-400" : "text-zinc-200"}`}
          >
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Feature importance chart ───────────────────────────────────────────────

interface FeatureImportance {
  name: string;
  linearImportance: number;
  treeImportance: number;
  linearCoefficient: number;
}

const FRIENDLY_FEATURE_NAMES: Record<string, string> = {
  resting_hr: "Resting heart rate",
  sleep_duration: "Sleep duration",
  deep_sleep: "Deep sleep",
  rem_sleep: "REM sleep",
  sleep_efficiency: "Sleep efficiency",
  exercise_minutes: "Exercise duration",
  cardio_minutes: "Cardio duration",
  strength_minutes: "Strength training duration",
  active_kcal: "Active calories burned",
  steps: "Daily steps",
  calories: "Caloric intake",
  protein_g: "Protein intake",
  carbs_g: "Carb intake",
  fat_g: "Fat intake",
  fiber_g: "Fiber intake",
  skin_temp: "Skin temperature",
};

function friendlyFeatureName(name: string): string {
  return FRIENDLY_FEATURE_NAMES[name] ?? formatFeatureNameFallback(name);
}

function FeatureImportanceChart({ importances }: { importances: FeatureImportance[] }) {
  const top = importances.slice(0, 12);
  const labels = top.map((f) => friendlyFeatureName(f.name));

  const option: EChartsOption = {
    title: {
      text: "What Matters Most for Your HRV",
      textStyle: { color: "#a1a1aa", fontSize: 12, fontWeight: "normal" },
      left: 0,
      top: 0,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
    },
    legend: {
      data: ["Advanced model", "Simple model"],
      textStyle: { color: "#71717a", fontSize: 10 },
      right: 0,
      top: 0,
    },
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    xAxis: {
      type: "value",
      name: "Relative importance",
      nameLocation: "middle",
      nameGap: 16,
      nameTextStyle: { color: "#52525b", fontSize: 9 },
      axisLabel: { color: "#52525b", fontSize: 9 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    yAxis: {
      type: "category",
      data: labels.reverse(),
      axisLabel: {
        color: "#a1a1aa",
        fontSize: 10,
        width: 160,
        overflow: "truncate",
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "Advanced model",
        type: "bar",
        data: [...top].reverse().map((f) => f.treeImportance),
        itemStyle: { color: "#34d399" },
        barWidth: 8,
      },
      {
        name: "Simple model",
        type: "bar",
        data: [...top].reverse().map((f) => f.linearImportance),
        itemStyle: { color: "#818cf8" },
        barWidth: 8,
      },
    ],
  };

  const height = Math.max(300, top.length * 35 + 60);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <ReactECharts option={option} style={{ height }} opts={{ renderer: "svg" }} />
      <p className="text-[10px] text-zinc-600 mt-2">
        Longer bars = bigger influence on your predicted HRV. The two models weigh factors
        differently — the advanced model can detect complex patterns the simple one can't.
      </p>
    </div>
  );
}

// ── Prediction vs actual scatter ───────────────────────────────────────────

interface PredictionPoint {
  date: string;
  actualHrv: number;
  linearPrediction: number;
  treePrediction: number;
}

function PredictionVsActualChart({ predictions }: { predictions: PredictionPoint[] }) {
  const allVals = predictions.flatMap((p) => [p.actualHrv, p.linearPrediction, p.treePrediction]);
  const min = Math.floor(Math.min(...allVals) * 0.9);
  const max = Math.ceil(Math.max(...allVals) * 1.1);

  const option: EChartsOption = {
    title: {
      text: "How Close Are the Predictions?",
      textStyle: { color: "#a1a1aa", fontSize: 12, fontWeight: "normal" },
      left: 0,
      top: 0,
    },
    tooltip: {
      trigger: "item",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
    },
    legend: {
      data: ["Advanced model", "Simple model", "Perfect prediction"],
      textStyle: { color: "#71717a", fontSize: 10 },
      right: 0,
      top: 0,
    },
    grid: { left: 8, right: 16, top: 40, bottom: 24, containLabel: true },
    xAxis: {
      type: "value",
      name: "What actually happened (HRV)",
      nameLocation: "middle",
      nameGap: 20,
      nameTextStyle: { color: "#71717a", fontSize: 10 },
      min,
      max,
      axisLabel: { color: "#52525b", fontSize: 9 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    yAxis: {
      type: "value",
      name: "What the model predicted",
      nameTextStyle: { color: "#71717a", fontSize: 10 },
      min,
      max,
      axisLabel: { color: "#52525b", fontSize: 9 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    series: [
      {
        name: "Advanced model",
        type: "scatter",
        data: predictions.map((p) => [p.actualHrv, p.treePrediction]),
        symbolSize: 4,
        itemStyle: { color: "#34d399", opacity: 0.5 },
      },
      {
        name: "Simple model",
        type: "scatter",
        data: predictions.map((p) => [p.actualHrv, p.linearPrediction]),
        symbolSize: 4,
        itemStyle: { color: "#818cf8", opacity: 0.3 },
      },
      {
        name: "Perfect prediction",
        type: "line",
        data: [
          [min, min],
          [max, max],
        ],
        lineStyle: { color: "#52525b", width: 1, type: "dashed" },
        symbol: "none",
        silent: true,
      },
    ],
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <ReactECharts option={option} style={{ height: 350 }} opts={{ renderer: "svg" }} />
      <p className="text-[10px] text-zinc-600 mt-2">
        Each dot is one day. Dots closer to the dashed line = the model got it right. Dots far from
        the line = the model was surprised.
      </p>
    </div>
  );
}

// ── Residual timeline ──────────────────────────────────────────────────────

function ResidualTimelineChart({ predictions }: { predictions: PredictionPoint[] }) {
  const option: EChartsOption = {
    title: {
      text: "Your HRV Over Time — Actual vs Predicted",
      textStyle: { color: "#a1a1aa", fontSize: 12, fontWeight: "normal" },
      left: 0,
      top: 0,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
    },
    legend: {
      data: ["Actual HRV", "Advanced model", "Simple model"],
      textStyle: { color: "#71717a", fontSize: 10 },
      right: 0,
      top: 0,
    },
    grid: { left: 8, right: 16, top: 40, bottom: 24, containLabel: true },
    xAxis: {
      type: "category",
      data: predictions.map((p) => p.date),
      axisLabel: { color: "#52525b", fontSize: 9, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "HRV (ms)",
      nameTextStyle: { color: "#71717a", fontSize: 10 },
      axisLabel: { color: "#52525b", fontSize: 9 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    dataZoom: [
      { type: "inside", start: 70, end: 100 },
      {
        type: "slider",
        start: 70,
        end: 100,
        height: 20,
        bottom: 0,
        borderColor: "#3f3f46",
        fillerColor: "rgba(52,211,153,0.1)",
        textStyle: { color: "#71717a", fontSize: 9 },
      },
    ],
    series: [
      {
        name: "Actual HRV",
        type: "line",
        data: predictions.map((p) => p.actualHrv),
        lineStyle: { color: "#e4e4e7", width: 1.5 },
        itemStyle: { color: "#e4e4e7" },
        symbol: "none",
      },
      {
        name: "Advanced model",
        type: "line",
        data: predictions.map((p) => p.treePrediction),
        lineStyle: { color: "#34d399", width: 1, type: "dashed" },
        itemStyle: { color: "#34d399" },
        symbol: "none",
      },
      {
        name: "Simple model",
        type: "line",
        data: predictions.map((p) => p.linearPrediction),
        lineStyle: { color: "#818cf8", width: 1, type: "dashed" },
        itemStyle: { color: "#818cf8" },
        symbol: "none",
      },
    ],
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <ReactECharts option={option} style={{ height: 300 }} opts={{ renderer: "svg" }} />
      <p className="text-[10px] text-zinc-600 mt-2">
        The white line is what actually happened. Dashed lines are what the models predicted. Where
        they diverge, something unexpected happened that day.
      </p>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-20 rounded-lg bg-zinc-800 animate-pulse" />
      <div className="flex gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 w-28 rounded-md bg-zinc-800 animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-80 rounded-lg bg-zinc-800 animate-pulse" />
        <div className="h-80 rounded-lg bg-zinc-800 animate-pulse" />
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatFeatureNameFallback(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\bg\b/g, "(g)")
    .replace(/\bkcal\b/g, "(kcal)")
    .replace(/\bmin\b/, "(min)")
    .replace(/^./, (c) => c.toUpperCase());
}
