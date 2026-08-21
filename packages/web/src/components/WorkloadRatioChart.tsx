import { formatDateShort, formatNumber, formatTrainingLoad } from "@dofek/format/format";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import type { WorkloadRatioResult, WorkloadRatioRow } from "dofek-server/types";
import {
  chartColors,
  dofekAxis,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { MethodExplanation } from "./MethodExplanation.tsx";

interface WorkloadRatioChartProps {
  data: WorkloadRatioRow[];
  context?: WorkloadRatioResult["context"];
  loading?: boolean;
}

export function WorkloadRatioChart({ data, context, loading }: WorkloadRatioChartProps) {
  if (loading) {
    return <DofekChart option={{}} loading={true} height={400} />;
  }

  if (data.length === 0) {
    return <DofekChart option={{}} empty={true} height={400} emptyMessage="No workload data" />;
  }

  if (!context) {
    throw new Error("Workload ratio context is required when chart data is present");
  }

  const recentLoadLabel = `Recent ${context.recentDays}-day Load`;
  const baselineLoadLabel = `${context.baselineDays}-day Baseline Load`;

  const option = {
    tooltip: dofekTooltip({
      formatter: (
        params: {
          seriesName: string;
          data: [string, number | null];
          color: string;
          axisIndex: number;
        }[],
      ) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = formatDateShort(firstParam.data[0]);
        let html = `<div style="font-weight:600;margin-bottom:4px">${escapeTooltipHtml(date)}</div>`;
        for (const p of params) {
          if (p.seriesName.startsWith("_")) continue;
          if (p.data[1] == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeTooltipHtml(p.color)}"></span>`;
          const valueText = p.seriesName.includes("Load")
            ? formatTrainingLoad(p.data[1])
            : formatNumber(p.data[1], 2);
          html += `<span>${escapeTooltipHtml(p.seriesName)}: <b>${escapeTooltipHtml(valueText)}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    }),
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    legend: dofekLegend(true, {
      data: ["Recent / baseline", recentLoadLabel, baselineLoadLabel],
    }),
    grid: [
      { top: 40, right: 20, bottom: "55%", left: 50 },
      { top: "55%", right: 20, bottom: 30, left: 50 },
    ],
    xAxis: [
      {
        ...dofekAxis.time({ axisLabel: { show: false } }),
        gridIndex: 0,
      },
      {
        ...dofekAxis.time(),
        gridIndex: 1,
      },
    ],
    yAxis: [
      {
        ...dofekAxis.value({ name: "Recent / baseline", min: 0 }),
        gridIndex: 0,
      },
      {
        ...dofekAxis.value({
          name: "Load",
          axisLabel: { formatter: (value: number) => formatTrainingLoad(value) },
        }),
        gridIndex: 1,
      },
    ],
    series: [
      // Recent-to-baseline ratio line (top grid)
      {
        ...dofekSeries.line(
          "Recent / baseline",
          data.map((d) => [d.date, d.workloadRatio]),
          {
            color: chartColors.amber,
            width: 2.5,
            z: 5,
          },
        ),
        xAxisIndex: 0,
        yAxisIndex: 0,
      },
      // Recent load area (bottom grid)
      {
        ...dofekSeries.line(
          recentLoadLabel,
          data.map((d) => [d.date, d.acuteLoad]),
          {
            color: chartColors.pink,
            areaStyle: { opacity: 0.15 },
            z: 3,
          },
        ),
        xAxisIndex: 1,
        yAxisIndex: 1,
      },
      // Baseline load area (bottom grid)
      {
        ...dofekSeries.line(
          baselineLoadLabel,
          data.map((d) => [d.date, d.chronicLoad]),
          {
            color: chartColors.blue,
            areaStyle: { opacity: 0.1 },
            z: 2,
          },
        ),
        xAxisIndex: 1,
        yAxisIndex: 1,
      },
    ],
  };

  return (
    <div>
      <DofekChart option={option} height={400} />
      <MethodExplanation
        className="mt-2"
        technicalName={TRAINING_TERMINOLOGY.workloadRatio.technicalName}
        lines={[context.description]}
      />
    </div>
  );
}
