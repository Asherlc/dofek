import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { trpc } from "../lib/trpc.ts";

const TARGET_DESCRIPTIONS: Record<string, string> = {
  hrv: "Heart rate variability measures how well your nervous system recovers. Higher is generally better.",
  resting_hr: "Your resting heart rate reflects cardiovascular fitness. Lower is generally better.",
  sleep_efficiency:
    "Sleep efficiency is the percentage of time in bed you actually spend asleep. Higher is better.",
  weight: "Body weight predicted from nutrition, exercise, and sleep patterns.",
  cardio_power:
    "Predicts your average power output for your next cardio session based on recent recovery, training load, and nutrition.",
  strength_volume:
    "Predicts your total training volume (weight x reps) for your next strength session based on recovery and recent training.",
};

const TARGET_FRIENDLY_LABELS: Record<string, string> = {
  hrv: "HRV",
  resting_hr: "Resting HR",
  sleep_efficiency: "Sleep Quality",
  weight: "Weight",
  cardio_power: "Cardio Power",
  strength_volume: "Strength Volume",
};

const CONFIDENCE_THRESHOLD_STRONG = 0.3;
const CONFIDENCE_THRESHOLD_MODERATE = 0.1;
const AGREEMENT_THRESHOLD_HIGH = 0.05;
const AGREEMENT_THRESHOLD_MODERATE = 0.15;
const MIN_FEATURE_IMPORTANCE = 0.01;
const MAX_FEATURES_SHOWN = 10;
const CHART_BAR_HEIGHT_PX = 36;
const CHART_PADDING_PX = 70;
const MIN_CHART_HEIGHT_PX = 250;
const TIMELINE_ZOOM_START = 70;

const TARGET_SECTIONS: { label: string; ids: string[] }[] = [
  { label: "Recovery", ids: ["hrv", "resting_hr", "sleep_efficiency"] },
  { label: "Fitness", ids: ["cardio_power", "strength_volume"] },
  { label: "Body", ids: ["weight"] },
];

export function PredictionsPage() {
  const [days, setDays] = useState(365);
  const [targetId, setTargetId] = useState("hrv");

  const targets = trpc.predictions.targets.useQuery();
  const prediction = trpc.predictions.predict.useQuery({ target: targetId, days });
  // Defaults to false (daily) while targets is loading — acceptable since
  // targets loads near-instantly as a static list and prediction data
  // (which uses isActivityTarget) takes longer to arrive.
  const isActivityTarget = targets.data?.find((t) => t.id === targetId)?.type === "activity";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6">
        <div>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
            What Drives Your Health?
          </h2>
          <p className="text-xs text-zinc-600 mt-0.5">
            Machine learning models analyze your sleep, exercise, and nutrition data to find what
            actually moves the needle on key health metrics.
          </p>
        </div>

        {targets.data && (
          <div className="flex flex-wrap gap-6">
            {TARGET_SECTIONS.map((section) => {
              const sectionTargets = targets.data.filter((t) => section.ids.includes(t.id));
              if (sectionTargets.length === 0) return null;
              return (
                <div key={section.label} className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-zinc-600 uppercase tracking-wider">
                    {section.label}
                  </span>
                  <div className="flex gap-2">
                    {sectionTargets.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTargetId(t.id)}
                        className={`px-3 py-1.5 rounded-lg border transition-colors text-left ${
                          targetId === t.id
                            ? "border-emerald-700 bg-emerald-950/50 text-zinc-100"
                            : "border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
                        }`}
                      >
                        <span className="text-xs font-medium block">
                          {TARGET_FRIENDLY_LABELS[t.id] ?? t.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {TARGET_DESCRIPTIONS[targetId] && (
          <p className="text-xs text-zinc-500 -mt-3">{TARGET_DESCRIPTIONS[targetId]}</p>
        )}

        {prediction.isLoading && <LoadingSkeleton />}

        {prediction.isError && (
          <div className="flex items-center justify-center h-32 text-red-400/70 text-sm">
            Something went wrong loading predictions. Try refreshing the page.
          </div>
        )}

        {prediction.data === null && !prediction.isLoading && !prediction.isError && (
          <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
            Not enough data yet.{" "}
            {isActivityTarget
              ? "Need at least 20 sessions with recorded data to find patterns."
              : "Need at least 20 days of readings to find patterns."}
          </div>
        )}

        {prediction.data && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TomorrowCard
                prediction={prediction.data.tomorrowPrediction}
                label={prediction.data.targetLabel}
                unit={prediction.data.targetUnit}
                isActivityTarget={isActivityTarget}
              />
              <KeyTakeaway
                importances={prediction.data.featureImportances}
                targetLabel={prediction.data.targetLabel}
                diagnostics={prediction.data.diagnostics}
                isActivityTarget={isActivityTarget}
              />
            </div>
            <FeatureImportanceChart
              importances={prediction.data.featureImportances}
              targetLabel={prediction.data.targetLabel}
            />
            <TimelineChart
              predictions={prediction.data.predictions}
              targetLabel={prediction.data.targetLabel}
              unit={prediction.data.targetUnit}
            />
            <ModelConfidence
              diagnostics={prediction.data.diagnostics}
              isActivityTarget={isActivityTarget}
            />
          </>
        )}
      </main>
    </div>
  );
}

// ── Key takeaway card ──────────────────────────────────────────────────────

interface FeatureImportance {
  name: string;
  linearImportance: number;
  treeImportance: number;
  linearCoefficient: number;
}

interface Diagnostics {
  linearRSquared: number;
  linearAdjustedRSquared: number;
  treeRSquared: number;
  crossValidatedRSquared: number;
  sampleCount: number;
  featureCount: number;
}

function KeyTakeaway({
  importances,
  targetLabel,
  diagnostics,
  isActivityTarget,
}: {
  importances: FeatureImportance[];
  targetLabel: string;
  diagnostics: Diagnostics;
  isActivityTarget: boolean;
}) {
  const top3 = importances.slice(0, 3).map((f) => friendlyFeatureName(f.name).toLowerCase());
  const confidenceLevel = getConfidenceLevel(diagnostics.crossValidatedRSquared);
  const timeframe = isActivityTarget ? "your next session's" : "tomorrow's";
  const sampleUnit = isActivityTarget ? "sessions" : "days";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 flex flex-col justify-between">
      <div>
        <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Key Finding</p>
        <p className="text-sm text-zinc-200 leading-relaxed">
          Your <span className="text-emerald-400 font-medium">{top3[0]}</span> has the biggest
          impact on {timeframe} {targetLabel.toLowerCase()}
          {top3.length > 1 && (
            <>
              , followed by <span className="text-emerald-400/70 font-medium">{top3[1]}</span>
              {top3.length > 2 && (
                <>
                  {" "}
                  and <span className="text-emerald-400/50 font-medium">{top3[2]}</span>
                </>
              )}
            </>
          )}
          .
        </p>
      </div>
      <p className="text-[10px] text-zinc-600 mt-3">
        Based on {diagnostics.sampleCount} {sampleUnit} of data.{" "}
        {confidenceLevel === "strong"
          ? "The models found clear patterns in your data."
          : confidenceLevel === "moderate"
            ? `The models found some patterns, but ${isActivityTarget ? "session-to-session" : "day-to-day"} variation is high.`
            : "Your data is quite variable — take these patterns as directional, not definitive."}
      </p>
    </div>
  );
}

function getConfidenceLevel(cvR2: number): "strong" | "moderate" | "weak" {
  if (cvR2 >= CONFIDENCE_THRESHOLD_STRONG) return "strong";
  if (cvR2 >= CONFIDENCE_THRESHOLD_MODERATE) return "moderate";
  return "weak";
}

// ── Tomorrow's prediction card ─────────────────────────────────────────────

interface TomorrowPrediction {
  linear: number;
  tree: number;
}

function TomorrowCard({
  prediction,
  label,
  unit,
  isActivityTarget,
}: {
  prediction: TomorrowPrediction | null;
  label: string;
  unit: string;
  isActivityTarget: boolean;
}) {
  if (!prediction) return null;

  const avg = (prediction.linear + prediction.tree) / 2;
  const spread = Math.abs(prediction.linear - prediction.tree);
  const agreement =
    spread < avg * AGREEMENT_THRESHOLD_HIGH
      ? "high"
      : spread < avg * AGREEMENT_THRESHOLD_MODERATE
        ? "moderate"
        : "low";
  const heading = isActivityTarget
    ? `Next Session's Predicted ${label}`
    : `Tomorrow's Predicted ${label}`;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">{heading}</p>
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold text-emerald-400">{avg.toFixed(0)}</span>
        <span className="text-sm text-zinc-500">{unit}</span>
        {agreement === "high" && (
          <span className="text-[10px] text-emerald-600 bg-emerald-950/50 px-2 py-0.5 rounded-full">
            Both models agree
          </span>
        )}
      </div>
      <p className="text-[10px] text-zinc-600 mt-2">
        {agreement === "high"
          ? "Two independent models arrived at nearly the same prediction — this gives us more confidence."
          : agreement === "moderate"
            ? `The two models predict ${prediction.linear.toFixed(0)} and ${prediction.tree.toFixed(0)} — reasonably close.`
            : `The models disagree (${prediction.linear.toFixed(0)} vs ${prediction.tree.toFixed(0)}) — ${isActivityTarget ? "this metric" : "tomorrow"} may be hard to predict.`}
      </p>
    </div>
  );
}

// ── Feature importance chart ───────────────────────────────────────────────

const FRIENDLY_FEATURE_NAMES: Record<string, string> = {
  // Daily features
  hrv: "HRV",
  resting_hr: "Resting heart rate",
  sleep_duration: "Sleep duration",
  deep_sleep: "Deep sleep",
  rem_sleep: "REM sleep",
  sleep_efficiency: "Sleep efficiency",
  exercise_minutes: "Exercise duration",
  cardio_minutes: "Cardio duration",
  strength_minutes: "Strength training",
  active_kcal: "Active calories",
  steps: "Daily steps",
  calories: "Calorie intake",
  protein_g: "Protein",
  carbs_g: "Carbs",
  fat_g: "Fat",
  fiber_g: "Fiber",
  skin_temp: "Skin temperature",
  // Activity trailing context features
  hrv_3d: "Recent HRV (3-day avg)",
  resting_hr_3d: "Recent resting HR (3-day avg)",
  sleep_duration_3d: "Recent sleep (3-day avg)",
  deep_sleep_3d: "Recent deep sleep (3-day avg)",
  sleep_efficiency_3d: "Recent sleep quality (3-day avg)",
  calories_3d: "Recent calorie intake (3-day avg)",
  protein_3d: "Recent protein intake (3-day avg)",
  weight_kg: "Body weight",
  exercise_minutes_7d: "Exercise level (7-day avg)",
  steps_7d: "Daily steps (7-day avg)",
  // Cardio features
  duration_min: "Session duration",
  avg_hr: "Average heart rate",
  avg_speed: "Average speed",
  total_distance: "Total distance",
  elevation_gain: "Elevation gain",
  avg_cadence: "Cadence",
  // Strength features
  working_set_count: "Number of working sets",
  max_weight: "Heaviest weight used",
  avg_rpe: "Average effort (RPE)",
  // Trailing session features
  days_since_last_session: "Days since last session",
  prev_session_target: "Previous session result",
  sessions_last_14d: "Sessions in last 2 weeks",
};

function friendlyFeatureName(name: string): string {
  return FRIENDLY_FEATURE_NAMES[name] ?? formatFeatureNameFallback(name);
}

function FeatureImportanceChart({
  importances,
  targetLabel,
}: {
  importances: FeatureImportance[];
  targetLabel: string;
}) {
  const meaningful = importances.filter((f) => f.treeImportance > MIN_FEATURE_IMPORTANCE);
  const top = meaningful.slice(0, MAX_FEATURES_SHOWN);
  const labels = top.map((f) => friendlyFeatureName(f.name));
  // Normalize to percentage for readability
  const maxImportance = Math.max(...top.map((f) => Math.max(f.treeImportance, f.linearImportance)));

  const option: EChartsOption = {
    title: {
      text: `What Influences Your ${targetLabel} Most`,
      subtext: "Ranked by impact — longer bars mean bigger effect",
      textStyle: { color: "#a1a1aa", fontSize: 13, fontWeight: "normal" },
      subtextStyle: { color: "#52525b", fontSize: 10 },
      left: 0,
      top: 0,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
      formatter: (params: unknown) => {
        if (!Array.isArray(params) || params.length === 0) return "";
        // ECharts tooltip params: each item has seriesName, value, name
        const items: Array<{ seriesName: string; value: number; name: string }> = JSON.parse(
          JSON.stringify(params),
        );
        const label = items[0]?.name;
        return `<strong>${label}</strong><br/>${items
          .map(
            (item) =>
              `${item.seriesName}: ${maxImportance > 0 ? ((item.value / maxImportance) * 100).toFixed(0) : 0}%`,
          )
          .join("<br/>")}`;
      },
    },
    grid: { left: 8, right: 16, top: 50, bottom: 8, containLabel: true },
    xAxis: {
      type: "value",
      show: false,
    },
    yAxis: {
      type: "category",
      data: labels.slice().reverse(),
      axisLabel: {
        color: "#a1a1aa",
        fontSize: 11,
        width: 160,
        overflow: "truncate",
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "Impact",
        type: "bar",
        data: top
          .slice()
          .reverse()
          .map((f) => f.treeImportance),
        itemStyle: {
          color: "#34d399",
          borderRadius: [0, 4, 4, 0],
        },
        barWidth: 14,
      },
    ],
  };

  const height = Math.max(MIN_CHART_HEIGHT_PX, top.length * CHART_BAR_HEIGHT_PX + CHART_PADDING_PX);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <ReactECharts option={option} style={{ height }} opts={{ renderer: "svg" }} />
    </div>
  );
}

// ── Timeline chart ─────────────────────────────────────────────────────────

interface PredictionPoint {
  date: string;
  actual: number;
  linearPrediction: number;
  treePrediction: number;
}

function TimelineChart({
  predictions,
  targetLabel,
  unit,
}: {
  predictions: PredictionPoint[];
  targetLabel: string;
  unit: string;
}) {
  const option: EChartsOption = {
    title: {
      text: `Your ${targetLabel} Over Time`,
      subtext: "White = actual, green dashed = what the model expected",
      textStyle: { color: "#a1a1aa", fontSize: 13, fontWeight: "normal" },
      subtextStyle: { color: "#52525b", fontSize: 10 },
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
      data: [`Actual`, "Model prediction"],
      textStyle: { color: "#71717a", fontSize: 10 },
      right: 0,
      top: 0,
    },
    grid: { left: 8, right: 16, top: 50, bottom: 24, containLabel: true },
    xAxis: {
      type: "category",
      data: predictions.map((p) => p.date),
      axisLabel: { color: "#52525b", fontSize: 9, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: `${targetLabel} (${unit})`,
      nameTextStyle: { color: "#71717a", fontSize: 10 },
      axisLabel: { color: "#52525b", fontSize: 9 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { lineStyle: { color: "#27272a" } },
    },
    dataZoom: [
      { type: "inside", start: TIMELINE_ZOOM_START, end: 100 },
      {
        type: "slider",
        start: TIMELINE_ZOOM_START,
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
        data: predictions.map((p) => p.actual),
        lineStyle: { color: "#e4e4e7", width: 1.5 },
        itemStyle: { color: "#e4e4e7" },
        symbol: "none",
      },
      {
        name: "Model prediction",
        type: "line",
        data: predictions.map((p) => p.treePrediction),
        lineStyle: { color: "#34d399", width: 1, type: "dashed" },
        itemStyle: { color: "#34d399" },
        symbol: "none",
      },
    ],
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <ReactECharts option={option} style={{ height: 300 }} opts={{ renderer: "svg" }} />
      <p className="text-[10px] text-zinc-600 mt-2">
        When the lines move together, the model understands what's driving your{" "}
        {targetLabel.toLowerCase()}. Big gaps mean something unusual happened that day.
      </p>
    </div>
  );
}

// ── Model confidence (replaces diagnostics bar) ────────────────────────────

function ModelConfidence({
  diagnostics,
  isActivityTarget,
}: {
  diagnostics: Diagnostics;
  isActivityTarget: boolean;
}) {
  const cvR2 = diagnostics.crossValidatedRSquared;
  const confidence = getConfidenceLevel(cvR2);

  const confidenceLabels = {
    strong: { text: "High confidence", color: "text-emerald-400", bg: "bg-emerald-950/50" },
    moderate: { text: "Moderate confidence", color: "text-yellow-400", bg: "bg-yellow-950/50" },
    weak: { text: "Low confidence", color: "text-orange-400", bg: "bg-orange-950/50" },
  };

  const { text, color, bg } = confidenceLabels[confidence];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">
          How Much Can We Trust This?
        </p>
        <span className={`text-xs font-medium ${color} ${bg} px-2 py-0.5 rounded-full`}>
          {text}
        </span>
      </div>
      <div className="flex gap-6 text-xs text-zinc-500">
        <span>
          Based on <span className="text-zinc-300">{diagnostics.sampleCount}</span>{" "}
          {isActivityTarget ? "sessions" : "days"}
        </span>
        <span>
          Using <span className="text-zinc-300">{diagnostics.featureCount}</span> factors
        </span>
      </div>
      <p className="text-[10px] text-zinc-600 mt-2">
        {confidence === "strong"
          ? "The model was tested on data it hadn't seen before and still predicted well. These patterns are reliable."
          : confidence === "moderate"
            ? "The model captures some real patterns, but health metrics are inherently variable. Use these as general guidance."
            : "Health is complex and many factors aren't captured here (stress, illness, etc). These patterns are suggestive but not definitive."}
      </p>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="h-28 rounded-lg bg-zinc-800 animate-pulse" />
        <div className="h-28 rounded-lg bg-zinc-800 animate-pulse" />
      </div>
      <div className="h-80 rounded-lg bg-zinc-800 animate-pulse" />
      <div className="h-64 rounded-lg bg-zinc-800 animate-pulse" />
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
