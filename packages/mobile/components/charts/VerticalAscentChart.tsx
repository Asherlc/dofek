import { formatNumber } from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { colors } from "../../theme";

export interface VerticalAscentDataPoint {
  date: string;
  activityName: string;
  verticalAscentRate: number;
  elevationGainMeters: number;
  climbingMinutes: number;
}

interface VerticalAscentChartProps {
  data: VerticalAscentDataPoint[];
  units: UnitConverter;
  /** Fixed width (optional — auto-measures via onLayout when omitted) */
  width?: number;
}

const PADDING = { top: 20, right: 16, bottom: 28, left: 48 };
const CHART_HEIGHT = 200;
const MIN_BUBBLE_RADIUS = 4;
const MAX_BUBBLE_RADIUS = 16;

export function VerticalAscentChart({ data, units, width: fixedWidth }: VerticalAscentChartProps) {
  const [measuredWidth, setMeasuredWidth] = useState(0);

  const onLayout = (event: LayoutChangeEvent) => {
    if (fixedWidth) return;
    setMeasuredWidth(event.nativeEvent.layout.width);
  };

  const containerWidth = fixedWidth ?? measuredWidth;

  if (data.length === 0) {
    return (
      <View style={styles.emptyContainer} onLayout={onLayout}>
        <Text style={styles.emptyText}>No activities with altitude data available</Text>
      </View>
    );
  }

  if (containerWidth === 0) {
    return (
      <View style={{ height: CHART_HEIGHT + PADDING.top + PADDING.bottom }} onLayout={onLayout} />
    );
  }

  const elevationLabel = units.elevationLabel;
  const plotWidth = containerWidth - PADDING.left - PADDING.right;

  // Convert to display units
  const points = data.map((point) => ({
    ...point,
    displayVam: units.convertElevation(point.verticalAscentRate),
    displayGain: units.convertElevation(point.elevationGainMeters),
    timestamp: new Date(point.date).getTime(),
  }));

  const timestamps = points.map((point) => point.timestamp);
  const vamValues = points.map((point) => point.displayVam);
  const maxGain = Math.max(...points.map((point) => point.displayGain));

  const xMin = Math.min(...timestamps);
  const xMax = Math.max(...timestamps);
  const yMin = Math.min(...vamValues);
  const yMax = Math.max(...vamValues);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  // Add 10% padding to y-axis
  const yPaddedMin = yMin - yRange * 0.1;
  const yPaddedMax = yMax + yRange * 0.1;
  const yPaddedRange = yPaddedMax - yPaddedMin || 1;

  const scaleX = (timestamp: number) => PADDING.left + ((timestamp - xMin) / xRange) * plotWidth;
  const scaleY = (vam: number) =>
    PADDING.top + CHART_HEIGHT - ((vam - yPaddedMin) / yPaddedRange) * CHART_HEIGHT;

  // Y-axis tick labels (3 values: min, mid, max)
  const yMid = (yPaddedMin + yPaddedMax) / 2;
  const yTicks = [yPaddedMin, yMid, yPaddedMax];

  const svgHeight = CHART_HEIGHT + PADDING.top + PADDING.bottom;

  return (
    <View onLayout={onLayout}>
      <Svg width={containerWidth} height={svgHeight}>
        {/* Y-axis */}
        <Line
          x1={PADDING.left}
          y1={PADDING.top}
          x2={PADDING.left}
          y2={PADDING.top + CHART_HEIGHT}
          stroke={colors.surfaceSecondary}
          strokeWidth={1}
        />
        {/* X-axis */}
        <Line
          x1={PADDING.left}
          y1={PADDING.top + CHART_HEIGHT}
          x2={PADDING.left + plotWidth}
          y2={PADDING.top + CHART_HEIGHT}
          stroke={colors.surfaceSecondary}
          strokeWidth={1}
        />

        {/* Y-axis tick labels */}
        {yTicks.map((tick) => (
          <SvgText
            key={tick}
            x={PADDING.left - 6}
            y={scaleY(tick) + 4}
            textAnchor="end"
            fontSize={10}
            fill={colors.textTertiary}
          >
            {formatNumber(tick, 0)}
          </SvgText>
        ))}

        {/* Grid lines */}
        {yTicks.map((tick) => (
          <Line
            key={`grid-${tick}`}
            x1={PADDING.left}
            y1={scaleY(tick)}
            x2={PADDING.left + plotWidth}
            y2={scaleY(tick)}
            stroke={colors.surfaceSecondary}
            strokeWidth={0.5}
            strokeDasharray="4,4"
            opacity={0.5}
          />
        ))}

        {/* Data bubbles */}
        {points.map((point) => {
          const radius =
            maxGain > 0
              ? MIN_BUBBLE_RADIUS +
                (point.displayGain / maxGain) * (MAX_BUBBLE_RADIUS - MIN_BUBBLE_RADIUS)
              : MIN_BUBBLE_RADIUS;

          return (
            <Circle
              key={`${point.date}-${point.activityName}`}
              cx={scaleX(point.timestamp)}
              cy={scaleY(point.displayVam)}
              r={radius}
              fill={colors.purple}
              opacity={0.7}
            />
          );
        })}
      </Svg>

      {/* Axis label */}
      <Text style={styles.axisLabel}>Vertical Ascent Rate ({elevationLabel}/h)</Text>
      <Text style={styles.caption}>
        Bubble size indicates elevation gain. Higher = stronger climbing.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyContainer: {
    height: 120,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
  },
  axisLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: 2,
  },
  caption: {
    fontSize: 10,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: 4,
  },
});
