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
            HRV Prediction — Machine Learning
          </h2>
          <p className="text-xs text-zinc-600 mt-0.5">
            Linear regression + gradient-boosted trees trained on your daily health data to predict
            next-day HRV.
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
            Linear: <span className="text-zinc-300">{prediction.linear.toFixed(1)}</span>
          </span>
          <span>
            Tree: <span className="text-zinc-300">{prediction.tree.toFixed(1)}</span>
          </span>
        </div>
      </div>
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

function DiagnosticsBar({ diagnostics }: { diagnostics: Diagnostics }) {
  const items = [
    { label: "Linear R²", value: diagnostics.linearRSquared.toFixed(3) },
    {
      label: "Linear Adj. R²",
      value: diagnostics.linearAdjustedRSquared.toFixed(3),
    },
    { label: "Tree R²", value: diagnostics.treeRSquared.toFixed(3) },
    {
      label: "CV R² (5-fold)",
      value: diagnostics.crossValidatedRSquared.toFixed(3),
      highlight: true,
    },
    { label: "Samples", value: diagnostics.sampleCount.toString() },
    { label: "Features", value: diagnostics.featureCount.toString() },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
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

function FeatureImportanceChart({ importances }: { importances: FeatureImportance[] }) {
  // Show top 12 features
  const top = importances.slice(0, 12);
  const labels = top.map((f) => formatFeatureName(f.name));

  const option: EChartsOption = {
    title: {
      text: "Feature Importance",
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
      data: ["Tree (GBRT)", "Linear (OLS)"],
      textStyle: { color: "#71717a", fontSize: 10 },
      right: 0,
      top: 0,
    },
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    xAxis: {
      type: "value",
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
        width: 120,
        overflow: "truncate",
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "Tree (GBRT)",
        type: "bar",
        data: [...top].reverse().map((f) => f.treeImportance),
        itemStyle: { color: "#34d399" },
        barWidth: 8,
      },
      {
        name: "Linear (OLS)",
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
        Tree importance = split variance reduction. Linear importance = standardized coefficient
        magnitude.
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
      text: "Predicted vs Actual HRV",
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
      data: ["Tree", "Linear", "Perfect"],
      textStyle: { color: "#71717a", fontSize: 10 },
      right: 0,
      top: 0,
    },
    grid: { left: 8, right: 16, top: 40, bottom: 24, containLabel: true },
    xAxis: {
      type: "value",
      name: "Actual HRV",
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
      name: "Predicted",
      nameTextStyle: { color: "#71717a", fontSize: 10 },
      min,
      max,
      axisLabel: { color: "#52525b", fontSize: 9 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    series: [
      {
        name: "Tree",
        type: "scatter",
        data: predictions.map((p) => [p.actualHrv, p.treePrediction]),
        symbolSize: 4,
        itemStyle: { color: "#34d399", opacity: 0.5 },
      },
      {
        name: "Linear",
        type: "scatter",
        data: predictions.map((p) => [p.actualHrv, p.linearPrediction]),
        symbolSize: 4,
        itemStyle: { color: "#818cf8", opacity: 0.3 },
      },
      {
        name: "Perfect",
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
        Points closer to the dashed line = more accurate predictions.
      </p>
    </div>
  );
}

// ── Residual timeline ──────────────────────────────────────────────────────

function ResidualTimelineChart({ predictions }: { predictions: PredictionPoint[] }) {
  const option: EChartsOption = {
    title: {
      text: "Actual HRV vs Model Predictions Over Time",
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
      data: ["Actual", "Tree", "Linear"],
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
        name: "Actual",
        type: "line",
        data: predictions.map((p) => p.actualHrv),
        lineStyle: { color: "#e4e4e7", width: 1.5 },
        itemStyle: { color: "#e4e4e7" },
        symbol: "none",
      },
      {
        name: "Tree",
        type: "line",
        data: predictions.map((p) => p.treePrediction),
        lineStyle: { color: "#34d399", width: 1, type: "dashed" },
        itemStyle: { color: "#34d399" },
        symbol: "none",
      },
      {
        name: "Linear",
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

function formatFeatureName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\bg\b/g, "(g)")
    .replace(/\bkcal\b/g, "(kcal)")
    .replace(/\bmin\b/, "(min)")
    .replace(/^./, (c) => c.toUpperCase());
}
