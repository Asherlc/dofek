import { stressColor, stressLabel, trendColor } from "@dofek/scoring/scoring";
import type { StressResult } from "dofek-server/types";
import { dofekAxis, dofekGrid, dofekLegend, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { DofekChart } from "./DofekChart.tsx";

interface StressChartProps {
  data: StressResult | undefined;
  loading?: boolean;
}

function trendIcon(trend: StressResult["trend"]): string {
  if (trend === "improving") return "\u2193";
  if (trend === "worsening") return "\u2191";
  return "\u2192";
}

export function StressChart({ data, loading }: StressChartProps) {
  if (loading) {
    return <DofekChart option={{}} loading={true} height={350} />;
  }

  if (!data || data.daily.length === 0) {
    return <DofekChart option={{}} empty={true} height={350} emptyMessage="No stress data" />;
  }

  const latest = data.latestScore ?? 0;
  const latestColor = stressColor(latest);

  const option = {
    grid: dofekGrid("dualAxis", { top: 50, bottom: 40 }),
    tooltip: dofekTooltip({
      formatter: (
        params: {
          dataIndex: number;
          marker: string;
          seriesName: string;
          value: [string, number];
        }[],
      ) => {
        if (!params?.[0]) return "";
        const idx = params[0].dataIndex;
        const day = data.daily[idx];
        if (!day) return "";
        const date = new Date(day.date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        html += `<div>Stress: <b style="color:${stressColor(day.stressScore)}">${formatNumber(day.stressScore)} (${stressLabel(day.stressScore)})</b></div>`;
        if (day.hrvDeviation != null)
          html += `<div>Heart rate variability deviation: <b>${day.hrvDeviation > 0 ? "+" : ""}${day.hrvDeviation}</b>\u03C3</div>`;
        if (day.restingHrDeviation != null)
          html += `<div>Resting heart rate deviation: <b>${day.restingHrDeviation > 0 ? "+" : ""}${day.restingHrDeviation}</b>\u03C3</div>`;
        if (day.sleepEfficiency != null)
          html += `<div>Sleep efficiency: <b>${day.sleepEfficiency}%</b></div>`;
        return html;
      },
    }),
    legend: dofekLegend(true, { data: ["Daily Stress", "Weekly Avg"] }),
    graphic: [
      {
        type: "text" as const,
        right: 10,
        top: 5,
        style: {
          text: `Today: ${formatNumber(latest)} ${stressLabel(latest)} ${trendIcon(data.trend)}`,
          fill: latestColor,
          fontSize: 13,
          fontWeight: "bold" as const,
        },
      },
    ],
    xAxis: dofekAxis.time(),
    yAxis: [
      dofekAxis.value({ name: "Stress (0-3)", min: 0, max: 3 }),
      dofekAxis.value({ name: "Weekly", position: "right", showSplitLine: false }),
    ],
    visualMap: {
      show: false,
      pieces: [
        { lte: 0.5, color: "#22c55e" },
        { gt: 0.5, lte: 1.5, color: "#eab308" },
        { gt: 1.5, lte: 2.5, color: "#f97316" },
        { gt: 2.5, color: "#ef4444" },
      ],
      seriesIndex: 0,
    },
    series: [
      {
        ...dofekSeries.bar(
          "Daily Stress",
          data.daily.map((d) => [d.date, d.stressScore]),
          {},
        ),
        barMaxWidth: 8,
      },
      dofekSeries.line(
        "Weekly Avg",
        data.weekly.map((w) => [w.weekStart, w.avgDailyStress]),
        {
          color: "#a78bfa",
          symbol: "circle",
          symbolSize: 6,
        },
      ),
    ],
  };

  return (
    <div>
      {/* Trend badge */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-xs font-medium px-2 py-0.5 rounded"
          style={{ color: trendColor(data.trend), backgroundColor: `${trendColor(data.trend)}15` }}
        >
          {trendIcon(data.trend)}{" "}
          {data.trend === "improving"
            ? "Improving"
            : data.trend === "worsening"
              ? "Worsening"
              : "Stable"}
        </span>
        {data.weekly.length > 0 && (
          <span className="text-dim text-xs">
            This week: {formatNumber(data.weekly[data.weekly.length - 1]?.cumulativeStress ?? 0)}{" "}
            cumulative
          </span>
        )}
      </div>
      <DofekChart option={option} height={300} />
    </div>
  );
}
