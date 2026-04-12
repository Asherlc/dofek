import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";
import { colors } from "../../theme";

const HEART_RATE_RED = "#ff453a";
const DOMAIN_MIN = 30;
const DOMAIN_MAX = 220;
const GRID_LINES = [60, 90, 120, 150, 180];

interface HeartRateChartProps {
  /** Heart rate values (bpm) to plot */
  data: number[];
  /** Fixed width (optional — fills parent if omitted) */
  width?: number;
  /** Fixed height (optional — fills parent if omitted) */
  height?: number;
  /** Line color (defaults to heart-rate red) */
  color?: string;
  /** Line stroke width */
  lineWidth?: number;
}

export function HeartRateChart({
  data,
  width: fixedWidth,
  height: fixedHeight,
  color = HEART_RATE_RED,
  lineWidth = 2.5,
}: HeartRateChartProps) {
  const [layout, setLayout] = useState({ width: fixedWidth ?? 0, height: fixedHeight ?? 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    if (fixedWidth && fixedHeight) return;
    const { width, height } = event.nativeEvent.layout;
    setLayout({ width, height });
  };

  const chartWidth = fixedWidth ?? layout.width;
  const chartHeight = fixedHeight ?? layout.height;

  if (data.length < 2 || chartWidth === 0 || chartHeight === 0) {
    return (
      <View
        style={{ width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 }}
        onLayout={onLayout}
      />
    );
  }

  const padding = 4;
  const yAxisWidth = 30;
  const plotWidth = chartWidth - yAxisWidth - padding;
  const plotHeight = chartHeight - padding * 2;
  const range = DOMAIN_MAX - DOMAIN_MIN;

  const toY = (bpm: number): number => {
    const clamped = Math.max(DOMAIN_MIN, Math.min(DOMAIN_MAX, bpm));
    return padding + plotHeight - ((clamped - DOMAIN_MIN) / range) * plotHeight;
  };

  const points = data
    .map((bpm, index) => {
      const pointX = yAxisWidth + (index / (data.length - 1)) * plotWidth;
      const pointY = toY(bpm);
      return `${pointX},${pointY}`;
    })
    .join(" ");

  return (
    <View
      style={[
        styles.container,
        { width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 },
      ]}
      onLayout={onLayout}
    >
      <Svg width={chartWidth} height={chartHeight}>
        {/* Horizontal grid lines */}
        {GRID_LINES.map((bpm) => {
          const gridY = toY(bpm);
          return (
            <Line
              key={bpm}
              x1={yAxisWidth}
              y1={gridY}
              x2={chartWidth - padding}
              y2={gridY}
              stroke={colors.surfaceSecondary}
              strokeWidth={StyleSheet.hairlineWidth}
              strokeDasharray="4,4"
            />
          );
        })}

        {/* HR line */}
        <Polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>

      {/* Y-axis labels */}
      <View style={[styles.yAxis, { height: chartHeight }]} pointerEvents="none">
        {GRID_LINES.map((bpm) => {
          const gridY = toY(bpm);
          return (
            <Text key={bpm} style={[styles.yLabel, { position: "absolute", top: gridY - 6 }]}>
              {bpm}
            </Text>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
  },
  yAxis: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 28,
  },
  yLabel: {
    fontSize: 10,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
    width: 26,
  },
});
