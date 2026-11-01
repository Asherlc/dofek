import { formatDateTime, formatNumber, formatTimeOnly } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import type { ActivityMetricSource } from "@dofek/providers/activity-metric-source";
import { activityMetricColors, statusColors } from "@dofek/scoring/colors";
import {
  type ActivityChartSeries,
  type ActivityChartWindow,
  activityChartSeries,
  nearestActivityChartSample,
} from "@dofek/training/activity-chart-series";
import {
  type ClimbingChartAnnotation,
  climbingChartPositions,
} from "@dofek/training/climbing-chart";
import { cadenceAxisLabel } from "@dofek/training/training";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ActivityHeartRateContext } from "../../../../../server/src/contracts/activity-metric-sources.ts";
import type { StreamPoint } from "../../../../../server/src/routers/activity.ts";
import { ActivityMetricSourcePicker } from "../../../components/ActivityMetricSourcePicker.tsx";
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
  const samples = dataPoints.map((point) => ({ timestamp: Date.parse(point.recordedAt), point }));
  const startedAt = Math.min(...samples.map((sample) => sample.timestamp));
  const endedAt = Math.max(...samples.map((sample) => sample.timestamp));
  return {
    updateAxisPointer: (params: Record<string, unknown>) => {
      const axesInfo = params.axesInfo;
      if (Array.isArray(axesInfo) && axesInfo.length > 0) {
        const rawValue: unknown = axesInfo[0]?.value;
        if (typeof rawValue === "number" && rawValue >= startedAt && rawValue <= endedAt) {
          const point = nearestActivityChartSample(samples, rawValue)?.point;
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

function chartSeriesData(series: ActivityChartSeries) {
  const data: Array<{
    value: [number, number | null];
    name: string;
    displayValue?: string;
    itemStyle: { opacity: number };
  }> = [];
  for (const [index, sample] of series.samples.entries()) {
    const timestampLabel = formatDateTime(new Date(sample.timestamp));
    const previous = series.samples[index - 1];
    if (sample.startsSegment && previous) {
      data.push({
        value: [previous.timestamp + (sample.timestamp - previous.timestamp) / 2, null],
        name: `Gap before ${timestampLabel}`,
        displayValue: "No recorded samples",
        itemStyle: { opacity: 0 },
      });
    }
    data.push({
      value: [sample.timestamp, sample.value],
      name: `Sample ${sample.index + 1} · ${timestampLabel}`,
      displayValue: formatNumber(sample.value, 0),
      itemStyle: { opacity: sample.showMarker ? 1 : 0 },
    });
  }
  return data;
}

interface MetricDefinition {
  name: string;
  axisName: string;
  color: string;
  data: Array<number | null>;
}

export function MetricsChart({
  points,
  activityWindow,
  heartRateContext,
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
  climbAnnotations = [],
  highlightedClimbId,
  selectedClimbId,
  onSelectClimb,
}: {
  points: StreamPoint[];
  activityWindow?: ActivityChartWindow;
  heartRateContext?: ActivityHeartRateContext;
  climbAnnotations?: readonly ClimbingChartAnnotation[];
  highlightedClimbId?: string | null;
  selectedClimbId?: string | null;
  onSelectClimb?: (entryId: string) => void;
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
    sources: ActivityMetricSource[];
    selectedId: string;
    onChange: (sourceId: string) => void;
  }>;
  renderLegend?: (controls: {
    isVisible: (name: string) => boolean;
    toggle: (name: string) => void;
  }) => ReactNode;
}) {
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean>>({});
  const [zoom, setZoom] = useState({ start: 0, end: 100 });
  const handleZoom = useCallback((params: Record<string, unknown>) => {
    const range = Array.isArray(params.batch) ? params.batch[0] : params;
    if (typeof range?.start === "number" && typeof range?.end === "number") {
      setZoom({ start: range.start, end: range.end });
    }
  }, []);
  const timeline = activityChartSeries(
    heartRateContext?.points ??
      points.map((point) => ({ recordedAt: point.recordedAt, value: null })),
    heartRateContext?.window ?? activityWindow,
  );
  const climbs = climbingChartPositions(climbAnnotations, timeline.startedAt, timeline.endedAt);
  const selectedPosition = climbs.find(({ annotation }) => annotation.id === selectedClimbId);
  const selectedStart = selectedPosition?.startPosition;
  const selectedEnd = selectedPosition?.endPosition;
  useEffect(() => {
    if (selectedClimbId == null || selectedStart === undefined || selectedEnd === undefined) return;
    setZoom((previous) => {
      const start = selectedStart * 100;
      const end = selectedEnd * 100;
      if (start >= previous.start && end <= previous.end) return previous;
      return {
        start: Math.min(previous.start, Math.max(0, start - 2)),
        end: Math.max(previous.end, Math.min(100, end + 2)),
      };
    });
  }, [selectedClimbId, selectedStart, selectedEnd]);
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
      datazoom: handleZoom,
      click: (params: Record<string, unknown>) => {
        if (params.componentType !== "markLine" && params.componentType !== "markArea") return;
        const data = params.data;
        if (
          data &&
          typeof data === "object" &&
          "climbId" in data &&
          typeof data.climbId === "string"
        ) {
          onSelectClimb?.(data.climbId);
        }
      },
    }),
    [points, onHoverPosition, handleLegendChange, handleZoom, onSelectClimb],
  );

  if (loading && metricSources.length === 0) return <ChartLoadingSkeleton height={300} />;
  if (points.length === 0 && !heartRateContext?.points.length && metricSources.length === 0)
    return null;

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
                  className={`flex min-h-11 shrink-0 items-center gap-1.5 px-2 text-xs font-medium ${isVisible(metric.name) ? "text-foreground" : "text-dim line-through"}`}
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
                    <ActivityMetricSourcePicker
                      key={metricSource.key}
                      label={metric.name}
                      sources={metricSource.sources}
                      selectedId={metricSource.selectedId}
                      onChange={metricSource.onChange}
                      className="max-w-60 rounded-r-md border-l border-border px-2"
                    />
                  ))}
              </div>
            ))}
          </fieldset>
        )
      : undefined);

  const isVisible = (name: string) => legendSelected[name] !== false;

  const climbTooltip = (annotation: ClimbingChartAnnotation) => ({
    formatter: () =>
      `${escapeTooltipHtml(annotation.label)}<br/>${escapeTooltipHtml(formatDateTime(new Date(annotation.startedAt)))}${annotation.endedAt ? ` – ${escapeTooltipHtml(formatDateTime(new Date(annotation.endedAt)))}` : ""}`,
  });
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
        axisLabel: { color: metric.color, formatter: (value: number) => formatNumber(value, 0) },
      }),
      show: visible,
      offset: !isFirst && visibleRightBefore > 0 ? visibleRightBefore * 60 : 0,
    };
  });

  const series = metrics.map((metric, index) => ({
    id: metric.name,
    name: metric.name,
    type: "line" as const,
    yAxisIndex: index,
    data: chartSeriesData(
      activityChartSeries(
        metric.name === "Heart Rate" && heartRateContext
          ? heartRateContext.points
          : points.map((point, dataIndex) => ({
              recordedAt: point.recordedAt,
              value: metric.data[dataIndex] ?? null,
            })),
        heartRateContext?.window ?? activityWindow,
      ),
    ),
    connectNulls: false,
    showSymbol: true,
    showAllSymbol: true,
    symbol: "circle",
    symbolSize: 6,
    emphasis: { itemStyle: { opacity: 1 } },
    lineStyle: { width: 1.5, color: metric.color },
    itemStyle: { color: metric.color },
    ...(metric.name === "Heart Rate" && climbs.length > 0
      ? {
          markLine: {
            animation: false,
            tooltip: { trigger: "item" },
            symbol: "none",
            lineStyle: { color: "#a78bfa", width: 1.5, type: "dashed" },
            label: { show: false },
            data: climbs
              .filter(({ annotation }) => annotation.endedAt === null)
              .map(({ annotation }) => ({
                id: annotation.id,
                climbId: annotation.id,
                name: annotation.label,
                xAxis: Date.parse(annotation.startedAt),
                tooltip: climbTooltip(annotation),
                lineStyle: {
                  width: annotation.id === highlightedClimbId ? 3 : 1.5,
                  type: annotation.id === highlightedClimbId ? "solid" : "dashed",
                },
                label: {
                  show: annotation.id === highlightedClimbId,
                  formatter: annotation.label,
                  position: "insideEndTop",
                  color: chartThemeColors.legendText,
                },
              })),
          },
          markArea: {
            animation: false,
            tooltip: { trigger: "item" },
            itemStyle: { color: "rgba(167,139,250,0.16)" },
            label: { show: false },
            data: climbs
              .filter(({ annotation }) => annotation.endedAt !== null)
              .map(({ annotation, startPosition, endPosition }) => [
                {
                  id: annotation.id,
                  climbId: annotation.id,
                  name: annotation.label,
                  xAxis:
                    timeline.startedAt + startPosition * (timeline.endedAt - timeline.startedAt),
                  tooltip: climbTooltip(annotation),
                  itemStyle: {
                    color:
                      annotation.id === highlightedClimbId
                        ? "rgba(167,139,250,0.36)"
                        : "rgba(167,139,250,0.16)",
                  },
                  label: {
                    show: annotation.id === highlightedClimbId,
                    formatter: annotation.label,
                    position: "insideTop",
                    color: chartThemeColors.legendText,
                  },
                },
                {
                  xAxis: timeline.startedAt + endPosition * (timeline.endedAt - timeline.startedAt),
                },
              ]),
          },
        }
      : {}),
  }));

  const visibleRightAxisCount = metrics.slice(1).filter((m) => isVisible(m.name)).length;

  const option = {
    aria: {
      label: {
        description:
          "Activity metrics over time. Dots mark recorded samples; gaps indicate unobserved time.",
      },
    },
    grid: {
      top: customLegend ? 24 : 40,
      right: 60 + Math.max(0, visibleRightAxisCount - 1) * 60,
      bottom: 86,
      left: 60,
    },
    tooltip: {
      ...dofekTooltip({
        axisPointer: {
          label: {
            formatter: ({ value }: { value: number }) => formatDateTime(new Date(value)),
          },
        },
      }),
      valueFormatter: (value: number) => formatNumber(value, 0),
    },
    legend: { ...dofekLegend(customLegend === undefined), selected: legendSelected },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, ...zoom },
      {
        type: "slider",
        xAxisIndex: 0,
        ...zoom,
        height: 32,
        bottom: 16,
        showDataShadow: false,
        showDetail: true,
        labelFormatter: (value: number) => formatTimeOnly(new Date(value)),
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
    xAxis: {
      ...dofekAxis.time({
        axisLabel: {
          formatter: (value: number) => formatTimeOnly(new Date(value)),
        },
      }),
      min: timeline.startedAt,
      max: timeline.endedAt,
      name: "Time",
      nameLocation: "middle",
      nameGap: 28,
    },
    yAxis: yAxes,
    series,
  };

  return (
    <figure className="m-0">
      {customLegend?.({ isVisible, toggle: toggleMetric })}
      {heartRateContext && isVisible("Heart Rate") && (
        <p className="mt-2 text-xs text-muted">
          {heartRateContext.window.endedAt
            ? "HR chart spans 5 minutes before and after the activity."
            : "HR chart starts 5 minutes before the activity."}
        </p>
      )}
      {loading ? (
        <ChartLoadingSkeleton height={300} />
      ) : points.length === 0 &&
        !heartRateContext?.points.length &&
        error ? null : points.length === 0 && !heartRateContext?.points.length ? (
        <p className="py-6 text-sm text-muted">No samples for the selected sources.</p>
      ) : (
        <DofekChart
          option={option}
          height={380}
          onEvents={chartEvents}
          timeRangeMode="data"
          notMerge={false}
          replaceMerge={["series"]}
        />
      )}
      {hasHr && isVisible("Heart Rate") && climbs.length > 0 && (
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer">Climbs ({climbs.length})</summary>
          <ul className="mt-2 space-y-1">
            {climbs.map(({ annotation }) => (
              <li key={annotation.id}>
                <button
                  type="button"
                  onClick={() => onSelectClimb?.(annotation.id)}
                  aria-pressed={annotation.id === selectedClimbId}
                  className="text-left text-accent"
                >
                  {annotation.label} · {formatDateTime(new Date(annotation.startedAt))}
                  {annotation.endedAt && ` – ${formatDateTime(new Date(annotation.endedAt))}`}
                </button>
              </li>
            ))}
          </ul>
        </details>
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
