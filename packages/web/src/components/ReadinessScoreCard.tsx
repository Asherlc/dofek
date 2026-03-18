import { scoreColor } from "@dofek/shared/scoring";
import type { ReadinessRow } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface ReadinessScoreCardProps {
  data: ReadinessRow[];
  loading?: boolean;
}

function ComponentBar({ label, value }: { label: string; value: number }) {
  const color = scoreColor(value);
  return (
    <div className="flex items-center gap-3">
      <span className="text-zinc-400 text-xs w-24 shrink-0">{label}</span>
      <div className="flex-1 bg-zinc-800 rounded-full h-2.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-zinc-300 text-xs w-8 text-right font-medium">{value}</span>
    </div>
  );
}

export function ReadinessScoreCard({ data, loading }: ReadinessScoreCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={280} />;
  }

  if (data.length === 0) {
    return (
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6 flex items-center justify-center h-[280px]">
        <span className="text-zinc-600 text-sm">No readiness data</span>
      </div>
    );
  }

  const latest = data[data.length - 1];
  if (!latest) return null;
  const score = latest.readinessScore;
  const color = scoreColor(score);

  // Sparkline data for the mini chart
  const sparklineOption = {
    backgroundColor: "transparent",
    grid: { top: 5, right: 0, bottom: 5, left: 0 },
    xAxis: {
      type: "category" as const,
      show: false,
      data: data.map((d) => d.date),
    },
    yAxis: {
      type: "value" as const,
      show: false,
      min: 0,
      max: 100,
    },
    series: [
      {
        type: "line",
        data: data.map((d) => d.readinessScore),
        smooth: true,
        symbol: "none",
        lineStyle: { color, width: 2 },
        areaStyle: {
          color: {
            type: "linear" as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${color}40` },
              { offset: 1, color: `${color}05` },
            ],
          },
        },
      },
    ],
    tooltip: { show: false },
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-zinc-400 text-sm font-medium mb-1">Readiness Score</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-bold" style={{ color }}>
              {score}
            </span>
            <span className="text-zinc-500 text-sm">/100</span>
          </div>
          <span className="text-zinc-600 text-xs">
            {new Date(latest.date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="w-32 h-16">
          <ReactECharts
            option={sparklineOption}
            style={{ height: 64, width: 128 }}
            notMerge={true}
          />
        </div>
      </div>

      <div className="space-y-2.5 mt-4">
        <ComponentBar label="Heart Rate Variability" value={latest.components.hrvScore} />
        <ComponentBar label="Resting Heart Rate" value={latest.components.restingHrScore} />
        <ComponentBar label="Sleep" value={latest.components.sleepScore} />
        <ComponentBar label="Load Balance" value={latest.components.loadBalanceScore} />
      </div>
    </div>
  );
}
