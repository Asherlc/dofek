import { operationalStatusColors } from "@dofek/scoring/colors";
import type { MicronutrientSafetyReviewRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { chartThemeColors, dofekAxis, dofekTooltip, escapeTooltipHtml } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface MicronutrientChartProps {
  data: MicronutrientSafetyReviewRow[];
  loading?: boolean;
}

export function MicronutrientChart({ data, loading }: MicronutrientChartProps) {
  const comparable = data.filter(
    (row) => row.adequacy?.status !== "not_evaluable" && row.adequacy != null,
  );
  const sorted = [...comparable].sort((a, b) => {
    const first = a.adequacy?.status !== "not_evaluable" ? a.adequacy?.percentDailyValue : 0;
    const second = b.adequacy?.status !== "not_evaluable" ? b.adequacy?.percentDailyValue : 0;
    return (first ?? 0) - (second ?? 0);
  });

  const option = {
    grid: { top: 10, right: 60, bottom: 30, left: 120 },
    tooltip: dofekTooltip({
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        const row = sorted[firstParam.dataIndex];
        if (!row) return "";
        const adequacy = row.adequacy;
        if (adequacy == null || adequacy.status === "not_evaluable") return "";
        const nutrient = escapeTooltipHtml(row.nutrient);
        const unit = escapeTooltipHtml(row.unit);
        return `<b>${nutrient}</b><br/>
          ${row.intake.totalDailyAverage} ${unit} / ${adequacy.reference.amount} ${unit}<br/>
          <b>${adequacy.percentDailyValue}% of FDA Daily Value (adequacy reference, not a safety rating)</b><br/>
          <span style="color:${chartThemeColors.axisLabel}">(average over ${row.intake.daysTracked} recorded days)</span>`;
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
          value: d.adequacy?.status !== "not_evaluable" ? (d.adequacy?.percentDailyValue ?? 0) : 0,
          itemStyle: {
            color:
              d.safetyStatus === "at_or_above_upper_limit"
                ? operationalStatusColors.danger.indicator
                : d.safetyStatus === "upper_limit_not_evaluable"
                  ? operationalStatusColors.warning.indicator
                  : operationalStatusColors.info.indicator,
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
            formatter: "100% FDA Daily Value",
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
      empty={comparable.length === 0}
      emptyMessage="No micronutrient data available"
      height={Math.max(300, sorted.length * 28)}
    />
  );
}
