import { formatDateTime, formatNumber, formatTimeOnly } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { activityMetricColors } from "@dofek/scoring/colors";
import {
  type ActivityChartSeries,
  type ActivityChartWindow,
  activityChartSeries,
} from "@dofek/training/activity-chart-series";
import {
  type ClimbingChartAnnotation,
  climbingChartPositions,
} from "@dofek/training/climbing-chart";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import type {
  ActivityHeartRateContext,
  ActivityMetricSources,
} from "../../../server/src/contracts/activity-metric-sources.ts";
import type { StreamPoint } from "../../../server/src/routers/activity.ts";
import { colors } from "../../theme";
import { AccessibleChart } from "../AccessibleChart";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker";
import { ACTIVITY_CHART_WIDTH } from "./chartDimensions";
import { useChartScrub } from "./useChartScrub";

const CHART_WIDTH = ACTIVITY_CHART_WIDTH;
const CHART_HEIGHT = 180;
const CHART_PADDING = { top: 20, right: 16, bottom: 28, left: 44 };
const NO_CLIMB_ANNOTATIONS: readonly ClimbingChartAnnotation[] = [];

export const CHART_COLORS = {
  heartRate: activityMetricColors.heartRate,
  power: activityMetricColors.power,
  speed: activityMetricColors.speed,
  cadence: activityMetricColors.cadence,
  skinTemperature: activityMetricColors.skinTemperature,
  altitude: "#6b7280",
};

export const chartStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});

type ActivityMetricControl = ActivityMetricSources[number] & {
  selectedId: string;
  onChange: (sourceId: string) => void;
};

export function ActivityMetricsCharts({
  points,
  sourceControls,
  serverUrl,
  activityWindow,
  cadenceLabel,
  isClimbingActivity,
  heartRateContext,
  climbingAnnotations,
  highlightedClimbId,
  onSelectClimb,
  hasHr,
  hasPower,
  hasAltitude,
  units,
  hasGps,
  onHoverIndex,
  onHoverTime,
  onScrubStart,
  onScrubEnd,
}: {
  points: StreamPoint[];
  sourceControls: ActivityMetricControl[];
  serverUrl: string;
  activityWindow: ActivityChartWindow;
  cadenceLabel: string;
  isClimbingActivity: boolean;
  heartRateContext?: ActivityHeartRateContext;
  climbingAnnotations?: readonly ClimbingChartAnnotation[];
  highlightedClimbId: string | null;
  onSelectClimb: (entryId: string | null) => void;
  hasHr: boolean;
  hasPower: boolean;
  hasAltitude: boolean;
  units: UnitConverter;
  hasGps: boolean;
  onHoverIndex: (index: number | null) => void;
  onHoverTime: (timestamp: number | null) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}) {
  const sourcePicker = (metric: ActivityMetricControl, showLabel = true) => (
    <ActivityMetricSourcePicker
      key={metric.key}
      label={metric.label}
      showLabel={showLabel}
      serverUrl={serverUrl}
      sources={metric.sources}
      selectedId={metric.selectedId}
      onChange={metric.onChange}
    />
  );
  const scrub = hasGps ? { onScrubStart, onScrubEnd } : {};
  return (
    <>
      {sourceControls
        .filter((metric) => metric.key === "heartRate")
        .map((metric) => sourcePicker(metric))}
      {hasHr && (
        <>
          <LineChart
            highlightedClimbId={highlightedClimbId}
            onSelectClimb={onSelectClimb}
            activityWindow={
              isClimbingActivity ? (heartRateContext?.window ?? activityWindow) : activityWindow
            }
            climbAnnotations={isClimbingActivity ? climbingAnnotations : undefined}
            data={
              isClimbingActivity && heartRateContext
                ? heartRateContext.points
                : points.map((point) => ({ recordedAt: point.recordedAt, value: point.heartRate }))
            }
            color={CHART_COLORS.heartRate}
            label="Heart Rate"
            unit="bpm"
            onHoverTime={hasGps ? onHoverTime : undefined}
            {...scrub}
          />
          {isClimbingActivity && heartRateContext && (
            <Text style={{ color: colors.textTertiary, fontSize: 13 }}>
              {heartRateContext.window.endedAt
                ? "HR chart spans 5 minutes before and after the activity."
                : "HR chart starts 5 minutes before the activity."}
            </Text>
          )}
        </>
      )}
      {sourceControls
        .filter((metric) => metric.key === "power")
        .map((metric) => sourcePicker(metric))}
      {hasPower && (
        <LineChart
          data={points.map((point) => ({ recordedAt: point.recordedAt, value: point.power }))}
          color={CHART_COLORS.power}
          label="Power"
          unit="W"
          onHoverIndex={hasGps ? onHoverIndex : undefined}
          {...scrub}
        />
      )}
      {sourceControls
        .filter((metric) => metric.key === "speed")
        .map((metric) => sourcePicker(metric))}
      {points.some((point) => point.speed != null) && (
        <LineChart
          data={points.map((point) => ({
            recordedAt: point.recordedAt,
            value: point.speed != null ? units.convertSpeed(point.speed * 3.6) : null,
          }))}
          color={CHART_COLORS.speed}
          label="Speed"
          unit={units.speedLabel}
          onHoverIndex={hasGps ? onHoverIndex : undefined}
          {...scrub}
        />
      )}
      {sourceControls
        .filter((metric) => metric.key === "cadence")
        .map((metric) => sourcePicker(metric))}
      {points.some((point) => point.cadence != null) && (
        <LineChart
          data={points.map((point) => ({ recordedAt: point.recordedAt, value: point.cadence }))}
          color={CHART_COLORS.cadence}
          label="Cadence"
          unit={cadenceLabel}
          onHoverIndex={hasGps ? onHoverIndex : undefined}
          {...scrub}
        />
      )}
      {sourceControls
        .filter((metric) => metric.key === "skinTemperature")
        .map((metric) => sourcePicker(metric))}
      {points.some((point) => point.skinTemperature != null) && (
        <LineChart
          data={points.flatMap((point) =>
            point.skinTemperature != null && point.skinTemperatureRecordedAt != null
              ? [
                  {
                    recordedAt: point.skinTemperatureRecordedAt,
                    value: units.convertTemperature(point.skinTemperature),
                  },
                ]
              : [],
          )}
          activityWindow={activityWindow}
          color={CHART_COLORS.skinTemperature}
          label="Skin Temperature"
          unit={units.temperatureLabel}
          precision={1}
          onHoverTime={hasGps ? onHoverTime : undefined}
          {...scrub}
        />
      )}
      {sourceControls
        .filter((metric) => metric.key === "altitude")
        .map((metric) => sourcePicker(metric, false))}
      {hasAltitude && (
        <AreaChart
          data={points.map((point) => ({
            recordedAt: point.recordedAt,
            value: point.altitude != null ? units.convertElevation(point.altitude) : null,
          }))}
          color={CHART_COLORS.altitude}
          label="Elevation Profile"
          unit={units.elevationLabel}
          onHoverIndex={hasGps ? onHoverIndex : undefined}
          {...scrub}
        />
      )}
    </>
  );
}

interface ChartProps {
  activityWindow?: ActivityChartWindow;
  climbAnnotations?: readonly ClimbingChartAnnotation[];
  highlightedClimbId?: string | null;
  onSelectClimb?: (entryId: string | null) => void;
  data: Array<{ recordedAt: string; value: number | null }>;
  color: string;
  label: string;
  unit: string;
  precision?: number;
  onHoverIndex?: (index: number | null) => void;
  onHoverTime?: (timestamp: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

function accessibleRows(series: ActivityChartSeries, unit: string, precision: number) {
  return series.samples.map((sample) => ({
    label: `Sample ${sample.index + 1} · ${formatDateTime(new Date(sample.timestamp))}`,
    value: `${formatNumber(sample.value, precision)} ${unit}`,
  }));
}

function TimeAxis({ series }: { series: ActivityChartSeries }) {
  return (
    <>
      {[0, 0.5, 1].map((position) => (
        <SvgText
          key={position}
          x={
            CHART_PADDING.left + position * (CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right)
          }
          y={CHART_HEIGHT - 6}
          fill={colors.textTertiary}
          fontSize={9}
          textAnchor={position === 0 ? "start" : position === 1 ? "end" : "middle"}
        >
          {formatTimeOnly(
            new Date(series.startedAt + position * (series.endedAt - series.startedAt)),
          )}
        </SvgText>
      ))}
    </>
  );
}

export function LineChart({
  data,
  activityWindow,
  color,
  label,
  unit,
  precision = 0,
  onHoverIndex,
  onHoverTime,
  onScrubStart,
  onScrubEnd,
  climbAnnotations = NO_CLIMB_ANNOTATIONS,
  highlightedClimbId,
  onSelectClimb,
}: ChartProps) {
  const [selectedClimbId, setSelectedClimbId] = useState<string | null>(null);
  const selectClimb = useCallback(
    (entryId: string | null) => {
      setSelectedClimbId(entryId);
      onSelectClimb?.(entryId);
    },
    [onSelectClimb],
  );
  const series = useMemo(() => activityChartSeries(data, activityWindow), [data, activityWindow]);
  const climbs = useMemo(
    () => climbingChartPositions(climbAnnotations, series.startedAt, series.endedAt),
    [climbAnnotations, series.startedAt, series.endedAt],
  );
  const selectedClimb = climbs.find(
    ({ annotation }) =>
      annotation.id === (highlightedClimbId === undefined ? selectedClimbId : highlightedClimbId),
  )?.annotation;
  const climbTimeLabel = (annotation: ClimbingChartAnnotation) =>
    `${formatDateTime(new Date(annotation.startedAt))}${annotation.endedAt ? ` – ${formatDateTime(new Date(annotation.endedAt))}` : ""}`;
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const handleHoverTime = useCallback(
    (timestamp: number | null) => {
      onHoverTime?.(timestamp);
      if (timestamp === null) return;
      const tolerance = (10 / plotWidth) * (series.endedAt - series.startedAt);
      let selected: ClimbingChartAnnotation | undefined;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const { annotation } of climbs) {
        if (annotation.endedAt !== null) continue;
        const start = Date.parse(annotation.startedAt);
        const distance = Math.abs(timestamp - start);
        if (distance <= tolerance && distance < closestDistance) {
          selected = annotation;
          closestDistance = distance;
        }
      }
      selected ??= climbs.find(
        ({ annotation }) =>
          annotation.endedAt !== null &&
          timestamp >= Date.parse(annotation.startedAt) &&
          timestamp <= Date.parse(annotation.endedAt),
      )?.annotation;
      selectClimb(selected?.id ?? null);
    },
    [climbs, plotWidth, series.startedAt, series.endedAt, onHoverTime, selectClimb],
  );
  const { touchIndex, panResponder } = useChartScrub({
    plotWidth,
    series,
    onHoverTime: handleHoverTime,
    onHoverIndex,
    onScrubStart,
    onScrubEnd,
  });

  const values = series.samples;

  if (values.length === 0) return null;

  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const toX = (sample: (typeof values)[number]) => CHART_PADDING.left + sample.position * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const chartPath = values
    .map(
      (sample) =>
        `${sample.startsSegment ? "M" : "L"}${toX(sample).toFixed(1)},${toY(sample.value).toFixed(1)}`,
    )
    .join(" ");

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  const touchedValue = touchIndex != null ? values.find((v) => v.index === touchIndex) : null;

  return (
    <AccessibleChart
      title={label}
      summary={`${label} over activity time. Dots mark recorded samples; gaps indicate unobserved time.`}
      rows={[
        ...accessibleRows(series, unit, precision),
        ...climbs.map(({ annotation }) => ({
          label: annotation.label,
          value: climbTimeLabel(annotation),
          onPress: () => selectClimb(annotation.id),
        })),
      ]}
    >
      <View style={chartStyles.container}>
        <Text style={chartStyles.title}>{label}</Text>
        <View {...panResponder.panHandlers}>
          <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
            {climbs.map(({ annotation, startPosition, endPosition }) => {
              const climbX = CHART_PADDING.left + startPosition * plotWidth;
              const width = (endPosition - startPosition) * plotWidth;
              return (
                <G key={annotation.id}>
                  {annotation.endedAt === null ? (
                    <Line
                      x1={climbX}
                      x2={climbX}
                      y1={CHART_PADDING.top}
                      y2={CHART_PADDING.top + plotHeight}
                      stroke="#a78bfa"
                      strokeWidth={annotation.id === selectedClimb?.id ? 3 : 1.5}
                      strokeDasharray={annotation.id === selectedClimb?.id ? undefined : "4,4"}
                    />
                  ) : (
                    <Rect
                      x={climbX}
                      y={CHART_PADDING.top}
                      width={width}
                      height={plotHeight}
                      fill="#a78bfa"
                      fillOpacity={annotation.id === selectedClimb?.id ? 0.36 : 0.16}
                    />
                  )}
                </G>
              );
            })}
            {yTicks.map((tick) => (
              <Line
                key={tick.value}
                x1={CHART_PADDING.left}
                y1={tick.y}
                x2={CHART_WIDTH - CHART_PADDING.right}
                y2={tick.y}
                stroke={colors.surfaceSecondary}
                strokeWidth={0.5}
              />
            ))}
            {yTicks.map((tick) => (
              <SvgText
                key={`label-${tick.value}`}
                x={CHART_PADDING.left - 6}
                y={tick.y + 4}
                fill={colors.textTertiary}
                fontSize={10}
                textAnchor="end"
              >
                {formatNumber(tick.value, precision)}
              </SvgText>
            ))}
            <SvgText
              x={CHART_PADDING.left - 6}
              y={CHART_PADDING.top - 8}
              fill={colors.textTertiary}
              fontSize={9}
              textAnchor="end"
            >
              {unit}
            </SvgText>
            <Path
              d={chartPath}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <TimeAxis series={series} />
            {values
              .filter((sample) => sample.showMarker)
              .map((sample) => (
                <Circle
                  key={sample.index}
                  cx={toX(sample)}
                  cy={toY(sample.value)}
                  r={3}
                  fill={color}
                />
              ))}
            {touchedValue != null && (
              <Line
                x1={toX(touchedValue)}
                y1={CHART_PADDING.top}
                x2={toX(touchedValue)}
                y2={CHART_PADDING.top + plotHeight}
                stroke={colors.textTertiary}
                strokeWidth={1}
                strokeDasharray="4,4"
              />
            )}
            {touchedValue != null && (
              <Circle
                cx={toX(touchedValue)}
                cy={toY(touchedValue.value)}
                r={4}
                fill={color}
                stroke="#ffffff"
                strokeWidth={2}
              />
            )}
          </Svg>
        </View>
        {climbs.length > 0 && (
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
            Climbs · tap a marker or band
          </Text>
        )}
        {selectedClimb && (
          <Text style={{ color: colors.text, fontSize: 12 }}>
            {selectedClimb.label} · {climbTimeLabel(selectedClimb)}
          </Text>
        )}
      </View>
    </AccessibleChart>
  );
}

export function AreaChart({
  data,
  color,
  label,
  unit,
  precision = 0,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: ChartProps) {
  const series = useMemo(() => activityChartSeries(data), [data]);
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const { touchIndex, panResponder } = useChartScrub({
    plotWidth,
    series,
    onHoverIndex,
    onScrubStart,
    onScrubEnd,
  });

  const values = series.samples;

  if (values.length === 0) return null;

  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const toX = (sample: (typeof values)[number]) => CHART_PADDING.left + sample.position * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const baselineY = CHART_PADDING.top + plotHeight;

  const linePath = values
    .map(
      (sample) =>
        `${sample.startsSegment ? "M" : "L"}${toX(sample).toFixed(1)},${toY(sample.value).toFixed(1)}`,
    )
    .join(" ");
  let segmentStartX = 0;
  const areaPath = values
    .map((sample, index) => {
      const sampleX = toX(sample).toFixed(1);
      if (sample.startsSegment) segmentStartX = toX(sample);
      const line = `${sample.startsSegment ? "M" : "L"}${sampleX},${toY(sample.value).toFixed(1)}`;
      return index === values.length - 1 || values[index + 1]?.startsSegment
        ? `${line} L${sampleX},${baselineY} L${segmentStartX.toFixed(1)},${baselineY} Z`
        : line;
    })
    .join(" ");

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  const touchedValue = touchIndex != null ? values.find((v) => v.index === touchIndex) : null;

  return (
    <AccessibleChart
      title={label}
      summary={`${label} over activity time. Dots mark recorded samples; gaps indicate unobserved time.`}
      rows={accessibleRows(series, unit, precision)}
    >
      <View style={chartStyles.container}>
        <Text style={chartStyles.title}>{label}</Text>
        <View {...panResponder.panHandlers}>
          <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
            <Defs>
              <LinearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={color} stopOpacity={0.3} />
                <Stop offset="1" stopColor={color} stopOpacity={0.05} />
              </LinearGradient>
            </Defs>
            {yTicks.map((tick) => (
              <Line
                key={tick.value}
                x1={CHART_PADDING.left}
                y1={tick.y}
                x2={CHART_WIDTH - CHART_PADDING.right}
                y2={tick.y}
                stroke={colors.surfaceSecondary}
                strokeWidth={0.5}
              />
            ))}
            {yTicks.map((tick) => (
              <SvgText
                key={`label-${tick.value}`}
                x={CHART_PADDING.left - 6}
                y={tick.y + 4}
                fill={colors.textTertiary}
                fontSize={10}
                textAnchor="end"
              >
                {formatNumber(tick.value, precision)}
              </SvgText>
            ))}
            <SvgText
              x={CHART_PADDING.left - 6}
              y={CHART_PADDING.top - 8}
              fill={colors.textTertiary}
              fontSize={9}
              textAnchor="end"
            >
              {unit}
            </SvgText>
            <Path d={areaPath} fill="url(#areaGrad)" />
            <Path
              d={linePath}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <TimeAxis series={series} />
            {values
              .filter((sample) => sample.showMarker)
              .map((sample) => (
                <Circle
                  key={sample.index}
                  cx={toX(sample)}
                  cy={toY(sample.value)}
                  r={3}
                  fill={color}
                />
              ))}
            {touchedValue != null && (
              <Line
                x1={toX(touchedValue)}
                y1={CHART_PADDING.top}
                x2={toX(touchedValue)}
                y2={CHART_PADDING.top + plotHeight}
                stroke={colors.textTertiary}
                strokeWidth={1}
                strokeDasharray="4,4"
              />
            )}
            {touchedValue != null && (
              <Circle
                cx={toX(touchedValue)}
                cy={toY(touchedValue.value)}
                r={4}
                fill={color}
                stroke="#ffffff"
                strokeWidth={2}
              />
            )}
          </Svg>
        </View>
      </View>
    </AccessibleChart>
  );
}
