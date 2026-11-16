import { formatDateTime, formatTimeOnly } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { activityChartSeries } from "@dofek/training/activity-chart-series";
import { useMemo } from "react";
import type { StreamPoint } from "../../../../../server/src/routers/activity.ts";
import { DofekChart } from "../../../components/DofekChart.tsx";
import { ChartLoadingSkeleton } from "../../../components/LoadingSkeleton.tsx";
import { dofekAxis, dofekGrid, dofekTooltip, escapeTooltipHtml } from "../../../lib/chartTheme.ts";
import { buildAxisPointerEvents, CHART_COLORS, chartSeriesData } from "./ActivityDetailCharts.tsx";

export function ElevationChart({
  points,
  loading,
  units,
  onHoverPosition,
}: {
  points: StreamPoint[];
  loading: boolean;
  units: UnitConverter;
  onHoverPosition?: (position: { lat: number; lng: number } | null) => void;
}) {
  const elevation = activityChartSeries(
    points.map((point) => ({
      recordedAt: point.recordedAt,
      value: point.altitude != null ? Math.round(units.convertElevation(point.altitude)) : null,
    })),
  );
  const chartEvents = useMemo(
    () => buildAxisPointerEvents(points, onHoverPosition),
    [points, onHoverPosition],
  );

  if (loading) return <ChartLoadingSkeleton height={200} />;
  if (elevation.samples.length === 0) return null;

  const option = {
    aria: {
      label: {
        description:
          "Elevation over activity time. Dots mark recorded samples; gaps indicate unobserved time.",
      },
    },
    grid: dofekGrid("single", { top: 10, right: 20, bottom: 30, left: 50 }),
    tooltip: dofekTooltip({
      formatter: (params: Array<{ value: [number, number | null]; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam || firstParam.value[1] == null) return "";
        return `${escapeTooltipHtml(formatDateTime(new Date(firstParam.value[0])))}<br/>Elevation: ${firstParam.value[1]} ${escapeTooltipHtml(units.elevationLabel)}`;
      },
    }),
    xAxis: {
      ...dofekAxis.time({
        axisLabel: {
          formatter: (value: number) => formatTimeOnly(new Date(value)),
        },
      }),
      min: elevation.startedAt,
      max: elevation.endedAt,
    },
    yAxis: { ...dofekAxis.value({ name: `Elevation (${units.elevationLabel})` }), scale: true },
    series: [
      {
        type: "line",
        data: chartSeriesData(elevation),
        connectNulls: false,
        showSymbol: true,
        showAllSymbol: true,
        symbol: "circle",
        symbolSize: 6,
        emphasis: { itemStyle: { opacity: 1 } },
        itemStyle: { color: CHART_COLORS.altitude },
        lineStyle: { width: 1.5, color: CHART_COLORS.altitude },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(107,114,128,0.3)" },
              { offset: 1, color: "rgba(107,114,128,0.05)" },
            ],
          },
        },
      },
    ],
  };

  return (
    <figure className="m-0">
      <DofekChart option={option} height={200} onEvents={chartEvents} timeRangeMode="data" />
    </figure>
  );
}
