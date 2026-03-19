import type { HealthspanMetric, HealthspanResult } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface HealthspanScoreCardProps {
  data: HealthspanResult | undefined;
  loading?: boolean;
}

function statusColor(status: HealthspanMetric["status"]): string {
  if (status === "excellent") return "#22c55e";
  if (status === "good") return "#3b82f6";
  if (status === "fair") return "#eab308";
  return "#ef4444";
}

function trendColor(trend: string): string {
  if (trend === "improving") return "#22c55e";
  if (trend === "stable") return "#3b82f6";
  return "#ef4444";
}

function trendLabel(trend: string): string {
  if (trend === "improving") return "Improving";
  if (trend === "stable") return "Stable";
  return "Declining";
}

export function HealthspanScoreCard({ data, loading }: HealthspanScoreCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={400} />;
  }

  if (!data || data.healthspanScore == null || data.metrics.length === 0) {
    return (
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6 flex items-center justify-center h-[400px]">
        <span className="text-zinc-600 text-sm">Insufficient data for healthspan analysis</span>
      </div>
    );
  }

  const scoreColor =
    data.healthspanScore >= 75 ? "#22c55e" : data.healthspanScore >= 50 ? "#eab308" : "#ef4444";

  // Radar chart for the 9 metrics
  const radarOption = {
    backgroundColor: "transparent",
    radar: {
      indicator: data.metrics.map((m) => ({ name: m.name, max: 100 })),
      shape: "circle" as const,
      axisName: { color: "#a1a1aa", fontSize: 10 },
      splitArea: { areaStyle: { color: ["transparent"] } },
      splitLine: { lineStyle: { color: "#3f3f46" } },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    series: [
      {
        type: "radar",
        data: [
          {
            value: data.metrics.map((m) => m.score),
            name: "Healthspan",
            areaStyle: { color: `${scoreColor}20` },
            lineStyle: { color: scoreColor, width: 2 },
            itemStyle: { color: scoreColor },
          },
        ],
      },
    ],
    tooltip: {
      trigger: "item" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
    },
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6">
      {/* Header with score + age */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-zinc-400 text-sm font-medium mb-1">Healthspan Score</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-bold" style={{ color: scoreColor }}>
              {data.healthspanScore}
            </span>
            <span className="text-zinc-500 text-sm">/100</span>
          </div>
        </div>

        <div className="text-right">
          {data.trend != null && (
            <div
              className="inline-block px-2 py-1 rounded text-xs font-medium"
              style={{
                color: trendColor(data.trend),
                backgroundColor: `${trendColor(data.trend)}15`,
              }}
            >
              {trendLabel(data.trend)}
            </div>
          )}
        </div>
      </div>

      {/* Radar chart */}
      <ReactECharts option={radarOption} style={{ height: 220 }} notMerge={true} />

      {/* Metric detail bars */}
      <div className="space-y-2 mt-2">
        {data.metrics.map((m) => (
          <div key={m.name} className="flex items-center gap-3">
            <span className="text-zinc-400 text-xs w-32 shrink-0">{m.name}</span>
            <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${m.score}%`, backgroundColor: statusColor(m.status) }}
              />
            </div>
            <span className="text-zinc-500 text-xs w-20 text-right tabular-nums">
              {m.value != null ? `${m.value} ${m.unit}` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
