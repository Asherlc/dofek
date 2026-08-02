import type { AerobicEfficiencyActivity, TrainingChartAvailability } from "dofek-server/types";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";
import { TrainingChartEmptyState } from "./TrainingChartEmptyState.tsx";

interface AerobicEfficiencyChartProps {
  activities: AerobicEfficiencyActivity[];
  maxHr: number | null;
  loading?: boolean;
  availability?: TrainingChartAvailability;
}

export function AerobicEfficiencyChart({
  activities,
  maxHr,
  loading,
  availability,
}: AerobicEfficiencyChartProps) {
  if (loading) {
    return (
      <DofekChart
        option={{}}
        loading={true}
        height={280}
        emptyMessage="No activities with sufficient Zone 2 power + heart rate data"
      />
    );
  }

  if (availability?.status === "insufficient_data") {
    return <TrainingChartEmptyState availability={availability} />;
  }

  if (activities.length === 0) {
    return (
      <DofekChart
        option={{}}
        empty={true}
        height={280}
        emptyMessage="No activities with sufficient Zone 2 power + heart rate data"
      />
    );
  }

  const powerData = activities.map((activity) => [activity.date, activity.avgPowerZ2]);
  const heartRateData = activities.map((activity) => [activity.date, activity.avgHrZ2]);
  const timeAxis = dofekAxis.time({ show: true });

  const option = {
    grid: dofekGrid("dualAxis", { top: 40, left: 55 }),
    tooltip: dofekTooltip(),
    xAxis: {
      ...timeAxis,
      name: "Date",
      nameLocation: "middle",
      nameGap: 28,
      axisLine: { ...timeAxis.axisLine, show: true },
      axisTick: { show: true },
    },
    yAxis: [
      dofekAxis.value({ name: "Power (W)" }),
      dofekAxis.value({
        name: "Heart Rate (bpm)",
        position: "right",
        showSplitLine: false,
      }),
    ],
    legend: dofekLegend(true),
    series: [
      dofekSeries.line("Power", powerData, {
        color: chartColors.orange,
        smooth: false,
        symbol: "circle",
        symbolSize: 6,
      }),
      dofekSeries.line("Heart Rate", heartRateData, {
        color: chartThemeColors.axisLabel,
        smooth: false,
        symbol: "circle",
        symbolSize: 6,
        yAxisIndex: 1,
      }),
    ],
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-subtle mb-2">
        Aerobic Efficiency (Zone 2 Power and Heart Rate)
        {maxHr && <span className="text-dim ml-2">(max heart rate: {maxHr} bpm)</span>}
      </h3>
      <DofekChart option={option} height={280} />
      <p className="text-xs text-dim mt-1">
        Each point is one activity with 5+ min of Zone 2 data (60-70% max heart rate).
      </p>
    </div>
  );
}
