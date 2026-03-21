import { healthStatusColor, scoreColor, trendColor } from "@dofek/scoring/scoring";
import type { HealthspanResult } from "dofek-server/types";
import { chartThemeColors, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface HealthspanScoreCardProps {
  data: HealthspanResult | undefined;
  loading?: boolean;
}

function TrendBadge({ trend }: { trend: "improving" | "declining" | "stable" }) {
  const c = trendColor(trend);
  return (
    <div
      className="inline-block px-2 py-1 rounded text-xs font-medium"
      style={{ color: c, backgroundColor: `${c}15` }}
    >
      {trend.charAt(0).toUpperCase() + trend.slice(1)}
    </div>
  );
}

export function HealthspanScoreCard({ data, loading }: HealthspanScoreCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={400} />;
  }

  if (!data || data.healthspanScore == null || data.metrics.length === 0) {
    return (
      <div className="bg-page border border-border rounded-xl p-6 flex items-center justify-center h-[400px]">
        <span className="text-dim text-sm">Insufficient data for healthspan analysis</span>
      </div>
    );
  }

  const color = scoreColor(data.healthspanScore);

  // Radar chart for the 9 metrics
  const radarOption = {
    radar: {
      indicator: data.metrics.map((m) => ({ name: m.name, max: 100 })),
      shape: "circle" as const,
      axisName: { color: chartThemeColors.legendText, fontSize: 10 },
      splitArea: { areaStyle: { color: ["transparent"] } },
      splitLine: { lineStyle: { color: chartThemeColors.tooltipBorder } },
      axisLine: { lineStyle: { color: chartThemeColors.tooltipBorder } },
    },
    series: [
      {
        type: "radar",
        data: [
          {
            value: data.metrics.map((m) => m.score),
            name: "Healthspan",
            areaStyle: { color: `${color}20` },
            lineStyle: { color, width: 2 },
            itemStyle: { color },
          },
        ],
      },
    ],
    tooltip: dofekTooltip({ trigger: "item" }),
  };

  return (
    <div className="bg-page border border-border rounded-xl p-6">
      {/* Header with score + age */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-muted text-sm font-medium mb-1">Healthspan Score</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-bold" style={{ color }}>
              {data.healthspanScore}
            </span>
            <span className="text-subtle text-sm">/100</span>
          </div>
        </div>

        <div className="text-right">{data.trend != null && <TrendBadge trend={data.trend} />}</div>
      </div>

      {/* Radar chart */}
      <DofekChart option={radarOption} height={220} />

      {/* Metric detail bars */}
      <div className="space-y-2 mt-2">
        {data.metrics.map((m) => (
          <div key={m.name} className="flex items-center gap-3">
            <span className="text-muted text-xs w-32 shrink-0">{m.name}</span>
            <div className="flex-1 bg-accent/10 rounded-full h-2 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${m.score}%`, backgroundColor: healthStatusColor(m.status) }}
              />
            </div>
            <span className="text-subtle text-xs w-20 text-right tabular-nums">
              {m.value != null ? `${m.value} ${m.unit}` : "\u2014"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
