import { statusColors } from "@dofek/scoring/colors";
import type { MicronutrientAdequacyRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { chartThemeColors, dofekAxis, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface MicronutrientChartProps {
  data: MicronutrientAdequacyRow[];
  loading?: boolean;
}

export function MicronutrientChart({ data, loading }: MicronutrientChartProps) {
  const sorted = [...data].sort((a, b) => a.percentRda - b.percentRda);

  const option = {
    grid: { top: 10, right: 60, bottom: 30, left: 120 },
    tooltip: dofekTooltip({
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        const row = sorted[firstParam.dataIndex];
        if (!row) return "";
        return `<b>${row.nutrient}</b><br/>
          ${row.avgIntake} ${row.unit} / ${row.rda} ${row.unit}<br/>
          <b>${row.percentRda}% of RDA</b><br/>
          <span style="color:${chartThemeColors.axisLabel}">(${row.daysTracked} days tracked)</span>`;
      },
    }),
    xAxis: {
      ...dofekAxis.value({
        axisLabel: { formatter: (v: number) => `${v}%` },
      }),
      max: (value: { max: number }) => Math.max(value.max, 150),
    },
    yAxis: dofekAxis.category({
      data: sorted.map((d) => d.nutrient),
      axisLabel: { color: chartThemeColors.legendText, fontSize: 11 },
    }),
    series: [
      {
        type: "bar",
        data: sorted.map((d) => ({
          value: d.percentRda,
          itemStyle: {
            color:
              d.percentRda >= 100
                ? statusColors.positive
                : d.percentRda >= 75
                  ? statusColors.warning
                  : d.percentRda >= 50
                    ? statusColors.elevated
                    : statusColors.danger,
          },
        })),
        barWidth: "60%",
        label: {
          show: true,
          position: "right" as const,
          color: chartThemeColors.legendText,
          fontSize: 11,
          formatter: (p: { value: number }) => `${p.value}%`,
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: chartThemeColors.tooltipBorder, type: "dashed" as const },
          data: [{ xAxis: 100 }],
          label: {
            show: true,
            position: "end" as const,
            formatter: "100% RDA",
            color: chartThemeColors.axisLabel,
          },
          tooltip: { show: false },
        },
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={loading}
      empty={data.length === 0}
      emptyMessage="No micronutrient data available"
      height={Math.max(300, sorted.length * 28)}
    />
  );
}
