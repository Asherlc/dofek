import { sleepStageColors } from "@dofek/scoring/colors";
import { dofekAxis, dofekGrid, dofekLegend, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface SleepData {
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
}

interface SleepChartProps {
  data: SleepData[];
  loading?: boolean;
}

export function SleepChart({ data, loading }: SleepChartProps) {
  const option = {
    grid: dofekGrid("single", { top: 30, bottom: 40, left: 50 }),
    tooltip: dofekTooltip({
      formatter: (
        params: { seriesName: string; value: [string, number | null]; color: string }[],
      ) => {
        if (!params.length) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = new Date(firstParam.value[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        let total = 0;
        const lines = params.map((p) => {
          const val = p.value[1] ?? 0;
          total += val;
          return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${val}m`;
        });
        return `<strong>${date}</strong> (${Math.floor(total / 60)}h ${total % 60}m)<br/>${lines.join("<br/>")}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "minutes" }),
    legend: dofekLegend(true),
    series: [
      dofekSeries.bar(
        "Deep",
        data.map((d) => [d.started_at, d.deep_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.deep,
        },
      ),
      dofekSeries.bar(
        "REM",
        data.map((d) => [d.started_at, d.rem_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.rem,
        },
      ),
      dofekSeries.bar(
        "Light",
        data.map((d) => [d.started_at, d.light_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.light,
        },
      ),
      dofekSeries.bar(
        "Awake",
        data.map((d) => [d.started_at, d.awake_minutes]),
        {
          stack: "sleep",
          color: sleepStageColors.awake,
        },
      ),
    ],
  };

  return <DofekChart option={option} loading={loading} empty={data.length === 0} />;
}
