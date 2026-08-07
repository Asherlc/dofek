import { activityMetricColors } from "@dofek/scoring/colors";
import { StyleSheet, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Polyline,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { AccessibleChart } from "../../components/AccessibleChart";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { colors } from "../../theme";
import { ACTIVITY_CHART_WIDTH } from "./chartDimensions";
import { useChartScrub } from "./useChartScrub";

const CHART_WIDTH = ACTIVITY_CHART_WIDTH;
const CHART_HEIGHT = 180;
const CHART_PADDING = { top: 20, right: 16, bottom: 28, left: 44 };

export const CHART_COLORS = {
  heartRate: activityMetricColors.heartRate,
  power: activityMetricColors.power,
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

interface ChartProps {
  data: Array<{ value: number | null }>;
  color: string;
  label: string;
  unit: string;
  onHoverIndex?: (index: number | null) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}

function accessibleRows(data: ChartProps["data"], unit: string) {
  return data.map((datum, index) => ({
    label: `Sample ${index + 1}`,
    value: datum.value === null ? "No value" : `${datum.value} ${unit}`,
  }));
}

export function LineChart({
  data,
  color,
  label,
  unit,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: ChartProps) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const { touchIndex, panResponder } = useChartScrub({
    plotWidth,
    totalPoints: data.length,
    onHoverIndex,
    onScrubStart,
    onScrubEnd,
  });

  const values = data
    .map((d, i) => (d.value != null ? { index: i, value: d.value } : null))
    .filter((d): d is { index: number; value: number } => d !== null);

  if (values.length < 2) return null;

  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const totalPoints = data.length;

  const toX = (index: number) =>
    CHART_PADDING.left + (index / Math.max(totalPoints - 1, 1)) * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const chartPoints = values
    .map((v) => `${toX(v.index).toFixed(1)},${toY(v.value).toFixed(1)}`)
    .join(" ");

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  const touchedValue = touchIndex != null ? values.find((v) => v.index === touchIndex) : null;

  return (
    <AccessibleChart
      title={label}
      summary={`${label} over the activity sample sequence.`}
      rows={accessibleRows(data, unit)}
    >
      <View style={chartStyles.container}>
        <ChartTitleWithTooltip
          title={label}
          description={`This chart shows how your ${label.toLowerCase()} changed over the activity timeline.`}
          textStyle={chartStyles.title}
        />
        <View {...panResponder.panHandlers}>
          <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
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
                {Math.round(tick.value)}
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
            <Polyline
              points={chartPoints}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {touchIndex != null && (
              <Line
                x1={toX(touchIndex)}
                y1={CHART_PADDING.top}
                x2={toX(touchIndex)}
                y2={CHART_PADDING.top + plotHeight}
                stroke={colors.textTertiary}
                strokeWidth={1}
                strokeDasharray="4,4"
              />
            )}
            {touchedValue != null && (
              <Circle
                cx={toX(touchedValue.index)}
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

export function AreaChart({
  data,
  color,
  label,
  unit,
  onHoverIndex,
  onScrubStart,
  onScrubEnd,
}: ChartProps) {
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const { touchIndex, panResponder } = useChartScrub({
    plotWidth,
    totalPoints: data.length,
    onHoverIndex,
    onScrubStart,
    onScrubEnd,
  });

  const values = data
    .map((d, i) => (d.value != null ? { index: i, value: d.value } : null))
    .filter((d): d is { index: number; value: number } => d !== null);

  if (values.length < 2) return null;

  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const minVal = Math.min(...values.map((v) => v.value));
  const maxVal = Math.max(...values.map((v) => v.value));
  const range = maxVal - minVal || 1;
  const totalPoints = data.length;

  const toX = (index: number) =>
    CHART_PADDING.left + (index / Math.max(totalPoints - 1, 1)) * plotWidth;
  const toY = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minVal) / range) * plotHeight;

  const baselineY = CHART_PADDING.top + plotHeight;

  const linePoints = values.map((v) => ({
    x: toX(v.index),
    y: toY(v.value),
  }));
  const firstPoint = linePoints[0];
  const lastPoint = linePoints[linePoints.length - 1];

  if (!firstPoint || !lastPoint) return null;

  const linePath = linePoints
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath = `${linePath} L${lastPoint.x.toFixed(1)},${baselineY} L${firstPoint.x.toFixed(1)},${baselineY} Z`;

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const value = minVal + (range * i) / 4;
    return { value, y: toY(value) };
  });

  const touchedValue = touchIndex != null ? values.find((v) => v.index === touchIndex) : null;

  return (
    <AccessibleChart
      title={label}
      summary={`${label} over the activity sample sequence.`}
      rows={accessibleRows(data, unit)}
    >
      <View style={chartStyles.container}>
        <ChartTitleWithTooltip
          title={label}
          description={`This chart shows how your ${label.toLowerCase()} changed over the activity timeline.`}
          textStyle={chartStyles.title}
        />
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
                {Math.round(tick.value)}
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
            {touchIndex != null && (
              <Line
                x1={toX(touchIndex)}
                y1={CHART_PADDING.top}
                x2={toX(touchIndex)}
                y2={CHART_PADDING.top + plotHeight}
                stroke={colors.textTertiary}
                strokeWidth={1}
                strokeDasharray="4,4"
              />
            )}
            {touchedValue != null && (
              <Circle
                cx={toX(touchedValue.index)}
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
