import type { PmcDataPoint, TssModelInfo } from "dofek-server/types";
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface PmcChartProps {
  data: PmcDataPoint[];
  model?: TssModelInfo | null;
  loading?: boolean;
}

/** Form zone boundaries (intervals.icu defaults). */
const ZONE_TRANSITION = 25;
const ZONE_FRESH = 5;
const ZONE_GREY = -10;
const ZONE_OPTIMAL = -30;

/** Colors matching intervals.icu */
const COLOR_FITNESS = "#3b82f6"; // blue
const COLOR_FATIGUE = "#8b5cf6"; // purple (intervals.icu uses purple, not pink)
const COLOR_TRANSITION = "#60a5fa"; // light blue
const COLOR_FRESH = "#22c55e"; // green
const COLOR_GREY = "#a1a1aa"; // grey
const COLOR_OPTIMAL = "#22c55e"; // green (optimal = gaining fitness)
const COLOR_HIGH_RISK = "#ef4444"; // red

function formColor(tsb: number): string {
  if (tsb > ZONE_TRANSITION) return COLOR_TRANSITION;
  if (tsb > ZONE_FRESH) return COLOR_FRESH;
  if (tsb > ZONE_GREY) return COLOR_GREY;
  if (tsb > ZONE_OPTIMAL) return COLOR_OPTIMAL;
  return COLOR_HIGH_RISK;
}

function ModelBadge({ model }: { model: TssModelInfo }) {
  if (model.type === "learned") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-emerald-900/40 text-emerald-400 border border-emerald-800/50">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Learned model (fit={model.r2?.toFixed(2)}, {model.pairedActivities} paired activities
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
  if (loading) {
    return <ChartLoadingSkeleton height={420} />;
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[420px]">
        <span className="text-zinc-600 text-sm">No training load data</span>
      </div>
    );
  }

  const lastPoint = data[data.length - 1];
  const lastDate = lastPoint
    ? new Date(lastPoint.date).toLocaleDateString("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";

  const option = {
    backgroundColor: "transparent",
    grid: [
      { top: 10, right: 15, bottom: "42%", left: 50 },
      { top: "64%", right: 15, bottom: 30, left: 50 },
    ],
    axisPointer: {
      link: [{ xAxisIndex: "all" }],
    },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
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
          `<span style="color:#71717a">Load:</span> ${load.toFixed(1)}`,
          `<span style="color:${COLOR_FITNESS}">Fitness:</span> ${fitness.toFixed(1)}`,
          `<span style="color:${COLOR_FATIGUE}">Fatigue:</span> ${fatigue.toFixed(1)}`,
          `<span style="color:${formColor(form)}">Form:</span> ${form.toFixed(1)}`,
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
    ],
    visualMap: {
      type: "piecewise" as const,
      show: false,
      seriesIndex: 3,
      dimension: 1,
      pieces: [
        { gte: ZONE_TRANSITION, color: COLOR_TRANSITION },
        { gte: ZONE_FRESH, lt: ZONE_TRANSITION, color: COLOR_FRESH },
        { gte: ZONE_GREY, lt: ZONE_FRESH, color: COLOR_GREY },
        { gte: ZONE_OPTIMAL, lt: ZONE_GREY, color: COLOR_OPTIMAL },
        { lt: ZONE_OPTIMAL, color: COLOR_HIGH_RISK },
      ],
    },
    series: [
      // ── Top pane: Load bars ──
      {
        name: "Load",
        type: "bar",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((d) => [d.date, d.load]),
        itemStyle: { color: "#71717a", opacity: 0.3 },
        barMaxWidth: 6,
        z: 1,
      },
      // ── Top pane: Fitness (CTL) line ──
      {
        name: "Fitness",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((d) => [d.date, d.ctl]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: COLOR_FITNESS, width: 2 },
        itemStyle: { color: COLOR_FITNESS },
        z: 3,
      },
      // ── Top pane: Fatigue (ATL) line ──
      {
        name: "Fatigue",
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: data.map((d) => [d.date, d.atl]),
        smooth: true,
        symbol: "none",
        lineStyle: { color: COLOR_FATIGUE, width: 2 },
        itemStyle: { color: COLOR_FATIGUE },
        z: 3,
      },
      // ── Bottom pane: Form (TSB) line — colored per zone by visualMap ──
      {
        name: "Form",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => [d.date, d.tsb]),
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2 },
        z: 3,
        markArea: {
          silent: true,
          data: [
            [
              {
                yAxis: ZONE_TRANSITION,
                itemStyle: { color: "rgba(96, 165, 250, 0.08)" },
                label: zoneLabel("Transition", COLOR_TRANSITION),
              },
              { yAxis: 200 },
            ],
            [
              {
                yAxis: ZONE_FRESH,
                itemStyle: { color: "rgba(74, 222, 128, 0.08)" },
                label: zoneLabel("Fresh", COLOR_FRESH),
              },
              { yAxis: ZONE_TRANSITION },
            ],
            [
              {
                yAxis: ZONE_GREY,
                itemStyle: { color: "rgba(161, 161, 170, 0.05)" },
                label: zoneLabel("Grey Zone", COLOR_GREY),
              },
              { yAxis: ZONE_FRESH },
            ],
            [
              {
                yAxis: ZONE_OPTIMAL,
                itemStyle: { color: "rgba(74, 222, 128, 0.06)" },
                label: zoneLabel("Optimal", COLOR_OPTIMAL),
              },
              { yAxis: ZONE_GREY },
            ],
            [
              {
                yAxis: -200,
                itemStyle: { color: "rgba(248, 113, 113, 0.08)" },
                label: zoneLabel("High Risk", COLOR_HIGH_RISK),
              },
              { yAxis: ZONE_OPTIMAL },
            ],
          ],
        },
      },
    ],
  };

  return (
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
            <div className="flex flex-col items-end justify-center gap-1" style={{ height: "58%" }}>
              <span className="text-zinc-500 text-[10px] leading-tight text-right">{lastDate}</span>
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
                <div className="text-sm font-semibold" style={{ color: formColor(lastPoint.tsb) }}>
                  {lastPoint.ctl > 0
                    ? `${Math.round((lastPoint.tsb / lastPoint.ctl) * 100)}%`
                    : Math.round(lastPoint.tsb)}
                </div>
              </div>
            </div>
            {/* Bottom pane zone labels — positioned in bottom ~42% */}
            <div
              className="flex flex-col items-end justify-center gap-0.5 text-[10px]"
              style={{ height: "42%" }}
            >
              <ZoneTag label="Transition" color={COLOR_TRANSITION} />
              <ZoneTag label="Fresh" color={COLOR_FRESH} />
              <ZoneTag label="Grey Zone" color={COLOR_GREY} />
              <ZoneTag label="Optimal" color={COLOR_OPTIMAL} />
              <ZoneTag label="High Risk" color={COLOR_HIGH_RISK} />
            </div>
          </div>
        )}
      </div>
    </div>
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

function zoneLabel(name: string, color: string) {
  return {
    show: true,
    position: "insideRight" as const,
    color,
    fontSize: 10,
    formatter: () => name,
  };
}
