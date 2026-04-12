import { chartColors } from "@dofek/scoring/colors";
import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";
import { colors } from "../../theme";

const DOMAIN_MIN = 30;
const DOMAIN_MAX = 220;
const GRID_LINES = [60, 90, 120, 150, 180];

const SOURCE_COLORS = [
  chartColors.teal,
  chartColors.purple,
  chartColors.blue,
  chartColors.green,
  chartColors.orange,
  chartColors.pink,
] as const;

export function sourceColor(index: number): string {
  return SOURCE_COLORS[index % SOURCE_COLORS.length] ?? SOURCE_COLORS[0];
}

export interface HeartRateSourceData {
  providerId: string;
  providerLabel: string;
  samples: { time: string; heartRate: number }[];
}

interface MultiSourceHeartRateChartProps {
  sources: HeartRateSourceData[];
  width?: number;
  height?: number;
}

export function MultiSourceHeartRateChart({
  sources,
  width: fixedWidth,
  height: fixedHeight,
}: MultiSourceHeartRateChartProps) {
  const [layout, setLayout] = useState({ width: fixedWidth ?? 0, height: fixedHeight ?? 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    if (fixedWidth && fixedHeight) return;
    const { width, height } = event.nativeEvent.layout;
    setLayout({ width, height });
  };

  const chartWidth = fixedWidth ?? layout.width;
  const chartHeight = fixedHeight ?? layout.height;

  const allSamples = sources.flatMap((source) => source.samples);
  if (allSamples.length < 2 || chartWidth === 0 || chartHeight === 0) {
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

  // Compute time range across all sources
  const allTimes = allSamples.map((sample) => new Date(sample.time).getTime());
  const timeMin = Math.min(...allTimes);
  const timeMax = Math.max(...allTimes);
  const timeRange = timeMax - timeMin || 1;

  const toY = (bpm: number): number => {
    const clamped = Math.max(DOMAIN_MIN, Math.min(DOMAIN_MAX, bpm));
    return padding + plotHeight - ((clamped - DOMAIN_MIN) / range) * plotHeight;
  };

  const toX = (time: string): number => {
    const milliseconds = new Date(time).getTime();
    return yAxisWidth + ((milliseconds - timeMin) / timeRange) * plotWidth;
  };

  return (
    <View
      style={[
        styles.container,
        { width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 },
      ]}
      onLayout={onLayout}
    >
      <Svg width={chartWidth} height={chartHeight}>
        {/* Grid lines */}
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

        {/* One line per source */}
        {sources.map((source, index) => {
          if (source.samples.length < 2) return null;
          const points = source.samples
            .map((sample) => `${toX(sample.time)},${toY(sample.heartRate)}`)
            .join(" ");
          return (
            <Polyline
              key={source.providerId}
              points={points}
              fill="none"
              stroke={sourceColor(index)}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
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
