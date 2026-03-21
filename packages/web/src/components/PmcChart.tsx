import {
  FORM_ZONE_COLORS,
  FORM_ZONE_FRESH,
  FORM_ZONE_GREY,
  FORM_ZONE_OPTIMAL,
  FORM_ZONE_TRANSITION,
  formZoneColor,
} from "@dofek/scoring/scoring";
import type { PmcDataPoint, TssModelInfo } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { createChartOptions } from "../lib/chart-theme.ts";
import { formatNumber } from "../lib/format.ts";
import { ChartContainer } from "./ChartContainer.tsx";

interface PmcChartProps {
  data: PmcDataPoint[];
  model?: TssModelInfo | null;
  loading?: boolean;
}

/** Colors matching intervals.icu */
const COLOR_FITNESS = "#3b82f6"; // blue
const COLOR_FATIGUE = "#8b5cf6"; // purple (intervals.icu uses purple, not pink)

function ModelBadge({ model }: { model: TssModelInfo }) {
  if (model.type === "learned") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Learned model (fit={model.r2 != null ? formatNumber(model.r2, 2) : "?"},{" "}
        {model.pairedActivities} paired activities
        {model.ftp != null && `, threshold ${model.ftp}W`})
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-400 border border-zinc-700/50">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500" />
      Generic heart rate model
      {model.pairedActivities > 0 && ` (${model.pairedActivities} paired activities — need 10+)`}
      {model.ftp != null && ` · threshold ${model.ftp}W`}
    </span>
  );
}

export function PmcChart({ data, model, loading }: PmcChartProps) {
  const lastPoint = data[data.length - 1];
  const lastDate = lastPoint
    ? new Date(lastPoint.date).toLocaleDateString("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";

  const option = createChartOptions({
    grid: [
      { top: 10, right: 15, bottom: "42%", left: 50 },
      { top: "64%", right: 15, bottom: 30, left: 50 },
    ],
    axisPointer: {
      link: [{ xAxisIndex: "all" }],
    },
    tooltip: {
      trigger: "axis" as const,
      formatter(
        params: Array<{
          seriesName: string;
          value: [string, number];
          marker: string;
          dataIndex: number;
        }>,
      ) {
        const first = params[0];
        if (!first) return "";
        const date = first.value[0];
        const label = new Date(date).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });

        // Find values by series name
        const load = params.find((p) => p.seriesName === "Load")?.value[1] ?? 0;
        const fitness = params.find((p) => p.seriesName === "Fitness")?.value[1] ?? 0;
        const fatigue = params.find((p) => p.seriesName === "Fatigue")?.value[1] ?? 0;
        const form = params.find((p) => p.seriesName === "Form")?.value[1] ?? 0;

        return [
          `<strong>${label}</strong>`,
          `<span style="color:#71717a">Load:</span> ${formatNumber(load)}`,
          `<span style="color:${COLOR_FITNESS}">Fitness:</span> ${formatNumber(fitness)}`,
          `<span style="color:${COLOR_FATIGUE}">Fatigue:</span> ${formatNumber(fatigue)}`,
          `<span style="color:${formZoneColor(form)}">Form:</span> ${formatNumber(form)}`,
        ].join("<br/>");
      },
    },
    xAxis: [
      {
        type: "time" as const,
        gridIndex: 0,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: "#3f3f46" } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      {
        type: "time" as const,
        gridIndex: 1,
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { lineStyle: { color: "#3f3f46" } },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: "value" as const,
        gridIndex: 0,
        name: "Training Load",
        nameTextStyle: { color: "#52525b", fontSize: 10 },
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
      },
      {
        type: "value" as const,
        gridIndex: 1,
        name: "Form",
        nameTextStyle: { color: "#52525b", fontSize: 10 },
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: false },
      },
      // Hidden axis for load bars so they don't compress the CTL/ATL scale
      {
        type: "value" as const,
        gridIndex: 0,
        show: false,
        min: 0,
      },
    ],
    visualMap: {
      type: "piecewise" as const,
      show: false,
      seriesIndex: 3,
      dimension: 1,
      pieces: [
        { gte: FORM_ZONE_TRANSITION, color: FORM_ZONE_COLORS.transition },
        { gte: FORM_ZONE_FRESH, lt: FORM_ZONE_TRANSITION, color: FORM_ZONE_COLORS.fresh },
        { gte: FORM_ZONE_GREY, lt: FORM_ZONE_FRESH, color: FORM_ZONE_COLORS.grey },
        { gte: FORM_ZONE_OPTIMAL, lt: FORM_ZONE_GREY, color: FORM_ZONE_COLORS.optimal },
        { lt: FORM_ZONE_OPTIMAL, color: FORM_ZONE_COLORS.highRisk },
      ],
    },
    series: [
      // ── Top pane: Load dots (scatter on hidden y-axis) ──
      {
        name: "Load",
        type: "scatter",
        xAxisIndex: 0,
        yAxisIndex: 2,
        data: data.filter((d) => d.load > 0).map((d) => [d.date, d.load]),
        itemStyle: { color: "#f87171", opacity: 0.7 },
        symbolSize: 4,
        z: 2,
      },
      // ── Top pane: Fitness (CTL) — area chart with fill ──
      {
        name: "Fitness",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((d) => [d.date, d.ctl]),
        symbol: "none",
        lineStyle: { color: COLOR_FITNESS, width: 2 },
        itemStyle: { color: COLOR_FITNESS },
        areaStyle: { color: "rgba(59, 130, 246, 0.12)" },
        z: 3,
        markLine: lastPoint
          ? {
              silent: true,
              symbol: "none",
              lineStyle: { color: "#71717a", type: "dashed" as const, width: 1 },
              label: { show: false },
              data: [{ yAxis: lastPoint.ctl }],
            }
          : undefined,
      },
      // ── Top pane: Fatigue (ATL) line ──
      {
        name: "Fatigue",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((d) => [d.date, d.atl]),
        symbol: "none",
        lineStyle: { color: COLOR_FATIGUE, width: 1.5 },
        itemStyle: { color: COLOR_FATIGUE },
        z: 4,
      },
      // ── Bottom pane: Form (TSB) line — colored per zone by visualMap ──
      {
        name: "Form",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => [d.date, d.tsb]),
        symbol: "none",
        lineStyle: { width: 2 },
        z: 3,
        markArea: {
          silent: true,
          itemStyle: { borderWidth: 0 },
          label: { show: false },
          data: [
            [
              { yAxis: FORM_ZONE_TRANSITION, itemStyle: { color: "rgba(96, 165, 250, 0.08)" } },
              { yAxis: 200 },
            ],
            [
              { yAxis: FORM_ZONE_FRESH, itemStyle: { color: "rgba(74, 222, 128, 0.08)" } },
              { yAxis: FORM_ZONE_TRANSITION },
            ],
            [
              { yAxis: FORM_ZONE_GREY, itemStyle: { color: "rgba(161, 161, 170, 0.05)" } },
              { yAxis: FORM_ZONE_FRESH },
            ],
            [
              { yAxis: FORM_ZONE_OPTIMAL, itemStyle: { color: "rgba(74, 222, 128, 0.06)" } },
              { yAxis: FORM_ZONE_GREY },
            ],
            [
              { yAxis: -200, itemStyle: { color: "rgba(248, 113, 113, 0.08)" } },
              { yAxis: FORM_ZONE_OPTIMAL },
            ],
          ],
        },
      },
    ],
  });

  return (
    <ChartContainer
      loading={!!loading}
      data={data}
      height={420}
      emptyMessage="No training load data"
    >
      <div>
        {model && (
          <div className="mb-2">
            <ModelBadge model={model} />
          </div>
        )}
        <div className="flex">
          <div className="flex-1 min-w-0">
            <ReactECharts option={option} style={{ height: 420 }} notMerge={true} />
          </div>
          {/* Right-side current values, matching intervals.icu */}
          {lastPoint && (
            <div className="flex flex-col w-[100px] pl-2 shrink-0">
              {/* Top pane values — positioned in top ~55% */}
              <div
                className="flex flex-col items-end justify-center gap-1"
                style={{ height: "58%" }}
              >
                <span className="text-zinc-500 text-[10px] leading-tight text-right">
                  {lastDate}
                </span>
                <div className="text-right">
                  <div className="text-zinc-500 text-[10px]">Fitness</div>
                  <div className="text-sm font-semibold" style={{ color: COLOR_FITNESS }}>
                    {Math.round(lastPoint.ctl)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-zinc-500 text-[10px]">Fatigue</div>
                  <div className="text-sm font-semibold" style={{ color: COLOR_FATIGUE }}>
                    {Math.round(lastPoint.atl)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-zinc-500 text-[10px]">Form</div>
                  <div
                    className="text-sm font-semibold"
                    style={{ color: formZoneColor(lastPoint.tsb) }}
                  >
                    {Math.round(lastPoint.tsb)}
                  </div>
                </div>
              </div>
              {/* Bottom pane zone labels — positioned in bottom ~42% */}
              <div
                className="flex flex-col items-end justify-center gap-0.5 text-[10px]"
                style={{ height: "42%" }}
              >
                <ZoneTag label="Transition" color={FORM_ZONE_COLORS.transition} />
                <ZoneTag label="Fresh" color={FORM_ZONE_COLORS.fresh} />
                <ZoneTag label="Grey Zone" color={FORM_ZONE_COLORS.grey} />
                <ZoneTag label="Optimal" color={FORM_ZONE_COLORS.optimal} />
                <ZoneTag label="High Risk" color={FORM_ZONE_COLORS.highRisk} />
              </div>
            </div>
          )}
        </div>
      </div>
    </ChartContainer>
  );
}

function ZoneTag({ label, color }: { label: string; color: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-[3px] h-3 rounded-sm" style={{ backgroundColor: color }} />
      <span style={{ color }}>{label}</span>
    </span>
  );
}
