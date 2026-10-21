import { formatDateTime, formatNumber, formatTimeOnly } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { activityMetricColors, statusColors } from "@dofek/scoring/colors";
import { cadenceAxisLabel } from "@dofek/training/training";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { StreamPoint } from "../../../../../server/src/routers/activity.ts";
import { DofekChart } from "../../../components/DofekChart.tsx";
import { ChartLoadingSkeleton } from "../../../components/LoadingSkeleton.tsx";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
  escapeTooltipHtml,
} from "../../../lib/chartTheme.ts";

const CHART_COLORS = {
  heartRate: activityMetricColors.heartRate,
  power: activityMetricColors.power,
  speed: activityMetricColors.speed,
  cadence: activityMetricColors.cadence,
  altitude: "#6b7280",
};

/**
 * Builds ECharts event handlers that translate axis pointer hover into a GPS position callback.
 * Used by MetricsChart and ElevationChart to sync hover with the RouteMap.
 */
function buildAxisPointerEvents(
  dataPoints: StreamPoint[],
  onHoverPosition?: (position: { lat: number; lng: number } | null) => void,
) {
  if (!onHoverPosition) return undefined;
  return {
    updateAxisPointer: (params: Record<string, unknown>) => {
      const axesInfo = params.axesInfo;
      if (Array.isArray(axesInfo) && axesInfo.length > 0) {
        const rawValue: unknown = axesInfo[0]?.value;
        if (typeof rawValue === "number" && rawValue >= 0 && rawValue < dataPoints.length) {
          const point = dataPoints[Math.round(rawValue)];
          if (point?.lat != null && point?.lng != null) {
            onHoverPosition({ lat: point.lat, lng: point.lng });
            return;
          }
        }
      }
      onHoverPosition(null);
    },
    globalout: () => onHoverPosition(null),
  };
}

interface MetricDefinition {
  name: string;
  axisName: string;
  color: string;
  data: Array<number | null>;
}

export function MetricsChart({
  points,
  activityType,
  hasHr,
  hasPower,
  hasSpeed,
  hasCadence,
  loading,
  units,
  onHoverPosition,
  renderLegend,
  metricSources = [],
  error,
}: {
  points: StreamPoint[];
  activityType: string;
  hasHr: boolean;
  hasPower: boolean;
  hasSpeed: boolean;
  hasCadence: boolean;
  loading: boolean;
  units: UnitConverter;
  onHoverPosition?: (position: { lat: number; lng: number } | null) => void;
  error?: { message: string } | null;
  metricSources?: Array<{
    key: string;
    label: string;
    sources: Array<{ id: string; label: string }>;
    selectedId: string;
    onChange: (sourceId: string) => void;
  }>;
  renderLegend?: (controls: {
    isVisible: (name: string) => boolean;
    toggle: (name: string) => void;
  }) => ReactNode;
}) {
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});
  const toggleMetric = useCallback((name: string) => {
    setLegendSelected((previous) => ({ ...previous, [name]: previous[name] === false }));
  }, []);

  const handleLegendChange = useCallback((params: Record<string, unknown>) => {
    const raw = params.selected;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const selected: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "boolean") {
          selected[key] = value;
        }
      }
      setLegendSelected(selected);
    }
  }, []);

  const chartEvents = useMemo(
    () => ({
      ...(buildAxisPointerEvents(points, onHoverPosition) ?? {}),
      legendselectchanged: handleLegendChange,
    }),
    [points, onHoverPosition, handleLegendChange],
  );

  if (loading && metricSources.length === 0) return <ChartLoadingSkeleton height={300} />;
  if (points.length === 0 && metricSources.length === 0) return null;

  const metrics: MetricDefinition[] = [];
  if (hasHr || metricSources.some((source) => source.key === "heartRate"))
    metrics.push({
      name: "Heart Rate",
      axisName: "Heart Rate (bpm)",
      color: CHART_COLORS.heartRate,
      data: points.map((p) => p.heartRate),
    });
  if (hasPower || metricSources.some((source) => source.key === "power"))
    metrics.push({
      name: "Power",
      axisName: "Power (W)",
      color: CHART_COLORS.power,
      data: points.map((p) => p.power),
    });
  if (hasSpeed || metricSources.some((source) => source.key === "speed"))
    metrics.push({
      name: "Speed",
      axisName: `Speed (${units.speedLabel})`,
      color: CHART_COLORS.speed,
      data: points.map((p) =>
        p.speed != null ? +formatNumber(units.convertSpeed(p.speed * 3.6)) : null,
      ),
    });
  if (hasCadence || metricSources.some((source) => source.key === "cadence"))
    metrics.push({
      name: "Cadence",
      axisName: cadenceAxisLabel(activityType),
      color: CHART_COLORS.cadence,
      data: points.map((p) => p.cadence),
    });

  const customLegend =
    renderLegend ??
    (metricSources.length > 0
      ? ({
          isVisible,
          toggle,
        }: {
          isVisible: (name: string) => boolean;
          toggle: (name: string) => void;
        }) => (
          <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
            <legend className="sr-only">Chart controls</legend>
            {metrics.map((metric) => (
              <div
                key={metric.name}
                className="inline-flex min-w-0 items-center rounded-md border border-border"
              >
                <button
                  type="button"
                  aria-label={`Toggle ${metric.name}`}
                  aria-pressed={isVisible(metric.name)}
                  onClick={() => toggle(metric.name)}
                  className={`flex min-h-9 items-center gap-1.5 px-2 text-xs font-medium ${isVisible(metric.name) ? "text-foreground" : "text-dim line-through"}`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: metric.color }}
                    aria-hidden="true"
                  />
                  {metric.name === "Heart Rate" ? "HR" : metric.name}
                </button>
                {metricSources
                  .filter((source) => source.label === metric.name)
                  .map((metricSource) => (
                    <select
                      key={metricSource.key}
                      aria-label={`${metric.name} source`}
                      value={metricSource.selectedId}
                      onChange={(event) => metricSource.onChange(event.target.value)}
                      className="min-h-9 min-w-0 max-w-44 rounded-r-md border-l border-border bg-transparent py-1 pl-2 pr-1 text-xs text-muted"
                    >
                      {metricSource.sources.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.label}
                        </option>
                      ))}
                    </select>
                  ))}
              </div>
            ))}
          </fieldset>
        )
      : undefined);

  const isVisible = (name: string) => legendSelected[name] !== false;

  const times = points.map((p) => p.recordedAt);
  const yAxes = metrics.map((metric, index) => {
    const visible = isVisible(metric.name);
    const isFirst = index === 0;
    const position = isFirst ? "left" : "right";
    const visibleRightBefore = metrics.slice(1, index).filter((m) => isVisible(m.name)).length;
    const firstVisibleIndex = metrics.findIndex((m) => isVisible(m.name));
    const showSplitLine = visible && index === firstVisibleIndex;

    return {
      ...dofekAxis.value({
        name: metric.axisName,
        min: "dataMin",
        max: "dataMax",
        position,
        showSplitLine,
        axisLabel: { color: metric.color },
      }),
      show: visible,
      offset: !isFirst && visibleRightBefore > 0 ? visibleRightBefore * 60 : 0,
    };
  });

  const series = metrics.map((metric, index) => ({
    name: metric.name,
    type: "line" as const,
    yAxisIndex: index,
    data: metric.data.map((value, dataIndex) =>
      value == null
        ? null
        : {
            value,
            itemStyle: {
              opacity:
                metric.data[dataIndex - 1] == null && metric.data[dataIndex + 1] == null ? 1 : 0,
            },
          },
    ),
    showSymbol: true,
    showAllSymbol: true,
    symbol: "circle",
    symbolSize: 6,
    emphasis: { itemStyle: { opacity: 1 } },
    lineStyle: { width: 1.5, color: metric.color },
    itemStyle: { color: metric.color },
  }));

  const visibleRightAxisCount = metrics.slice(1).filter((m) => isVisible(m.name)).length;

  const option = {
    grid: {
      top: customLegend ? 24 : 40,
      right: 60 + Math.max(0, visibleRightAxisCount - 1) * 60,
      bottom: 86,
      left: 60,
    },
    tooltip: dofekTooltip({
      axisPointer: {
        label: {
          formatter: ({ value }: { value: string }) => formatDateTime(value),
        },
      },
    }),
    legend: { ...dofekLegend(customLegend === undefined), selected: legendSelected },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, start: 0, end: 100 },
      {
        type: "slider",
        xAxisIndex: 0,
        start: 0,
        end: 100,
        height: 32,
        bottom: 16,
        showDataShadow: false,
        showDetail: true,
        labelFormatter: (_value: number, valueText: string) => formatTimeOnly(valueText),
        handleSize: "100%",
        moveHandleSize: 8,
        brushSelect: false,
        borderRadius: 4,
        borderColor: chartThemeColors.tooltipBorder,
        backgroundColor: chartThemeColors.tooltipBackground,
        fillerColor: `${statusColors.positive}26`,
        handleStyle: {
          color: statusColors.positive,
          borderColor: chartThemeColors.tooltipBackground,
          borderWidth: 2,
        },
        moveHandleStyle: { color: statusColors.positive },
        textStyle: { color: chartThemeColors.axisLabel },
      },
    ],
    xAxis: dofekAxis.category({
      data: times,
      axisLabel: {
        formatter: (v: string) => formatTimeOnly(v),
      },
    }),
    yAxis: yAxes,
    series,
  };

  return (
    <figure className="m-0">
      {customLegend?.({ isVisible, toggle: toggleMetric })}
      {loading ? (
        <ChartLoadingSkeleton height={300} />
      ) : points.length === 0 && error ? null : points.length === 0 ? (
        <p className="py-6 text-sm text-muted">No samples for the selected sources.</p>
      ) : (
        <DofekChart option={option} height={380} onEvents={chartEvents} />
      )}
      {points.length > 0 && (
        <figcaption className="mt-1 flex flex-wrap items-baseline gap-x-2 px-[60px] text-xs text-dim">
          <span className="font-medium text-muted">Zoom timeline</span>
          <span>Drag the handles to focus on part of the activity.</span>
        </figcaption>
      )}
    </figure>
  );
}

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
  const elevPoints = points.filter((p) => p.altitude != null);
  const chartEvents = useMemo(
    () => buildAxisPointerEvents(elevPoints, onHoverPosition),
    [elevPoints, onHoverPosition],
  );

  if (loading) return <ChartLoadingSkeleton height={200} />;
  if (elevPoints.length === 0) return null;

  const option = {
    grid: dofekGrid("single", { top: 10, right: 20, bottom: 30, left: 50 }),
    tooltip: dofekTooltip({
      formatter: (params: Array<{ value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        return `Elevation: ${Math.round(units.convertElevation(firstParam.value))} ${escapeTooltipHtml(units.elevationLabel)}`;
      },
    }),
    xAxis: dofekAxis.category({
      data: elevPoints.map((p) => p.recordedAt),
      axisLabel: {
        formatter: (v: string) => formatTimeOnly(v),
      },
    }),
    yAxis: { ...dofekAxis.value({ name: `Elevation (${units.elevationLabel})` }), scale: true },
    series: [
      {
        type: "line",
        data: elevPoints.map((p) =>
          p.altitude != null ? Math.round(units.convertElevation(p.altitude)) : null,
        ),
        showSymbol: false,
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

  return <DofekChart option={option} height={200} onEvents={chartEvents} />;
}
