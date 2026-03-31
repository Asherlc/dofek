import { useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import Svg, { Line, Polyline, Rect } from "react-native-svg";
import { colors } from "../../theme";

interface ChartDomain {
  min: number;
  max: number;
}

interface BackgroundBand {
  min: number;
  max: number;
  color: string;
}

interface SparkLineProps {
  /** Data points to plot (null values create visible gaps) */
  data: (number | null)[];
  /** Fixed width of the chart (optional) */
  width?: number;
  /** Fixed height of the chart (optional) */
  height?: number;
  /** Line color */
  color?: string;
  /** Line stroke width */
  lineWidth?: number;
  /** Show baseline (average) */
  showBaseline?: boolean;
  /** Fixed y-axis domain for threshold-based charts */
  domain?: ChartDomain;
  /** Background threshold layers aligned to the y-axis domain */
  backgroundBands?: BackgroundBand[];
}

/** Split data into contiguous non-null segments for gap rendering */
function splitSegments(
  data: (number | null)[],
  padding: number,
  chartWidth: number,
  chartHeight: number,
  min: number,
  max: number,
  range: number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value != null) {
      const clampedValue = Math.max(min, Math.min(max, value));
      const pointX = padding + (i / (data.length - 1)) * chartWidth;
      const pointY = padding + chartHeight - ((clampedValue - min) / range) * chartHeight;
      current.push(`${pointX},${pointY}`);
    } else {
      if (current.length >= 2) {
        segments.push(current.join(" "));
      }
      current = [];
    }
  }
  if (current.length >= 2) {
    segments.push(current.join(" "));
  }
  return segments;
}

export function SparkLine({
  data,
  width: fixedWidth,
  height: fixedHeight,
  color = "#00E676",
  lineWidth = 2,
  showBaseline = false,
  domain,
  backgroundBands,
}: SparkLineProps) {
  const [layout, setLayout] = useState({ width: fixedWidth ?? 0, height: fixedHeight ?? 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    if (fixedWidth && fixedHeight) return;
    const { width, height } = event.nativeEvent.layout;
    setLayout({ width, height });
  };

  const currentWidth = fixedWidth ?? layout.width;
  const currentHeight = fixedHeight ?? layout.height;

  const nonNullValues = data.filter((v): v is number => v != null);

  if (nonNullValues.length < 2 || currentWidth === 0 || currentHeight === 0) {
    return (
      <View
        style={{ width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 }}
        onLayout={onLayout}
      />
    );
  }

  const padding = 2;
  const chartWidth = currentWidth - padding * 2;
  const chartHeight = currentHeight - padding * 2;

  const min = domain?.min ?? Math.min(...nonNullValues);
  const max = domain?.max ?? Math.max(...nonNullValues);
  const range = max - min || 1;

  const segments = splitSegments(data, padding, chartWidth, chartHeight, min, max, range);

  const avg = nonNullValues.reduce((sum, v) => sum + v, 0) / nonNullValues.length;
  const avgY = padding + chartHeight - ((avg - min) / range) * chartHeight;

  const chartBackgroundBands =
    backgroundBands?.flatMap((backgroundBand) => {
      const clampedStart = Math.max(min, Math.min(max, backgroundBand.min));
      const clampedEnd = Math.max(min, Math.min(max, backgroundBand.max));

      if (clampedEnd <= clampedStart) return [];

      const startY = padding + chartHeight - ((clampedStart - min) / range) * chartHeight;
      const endY = padding + chartHeight - ((clampedEnd - min) / range) * chartHeight;
      const bandHeight = Math.max(0, startY - endY);

      return (
        <Rect
          key={`${backgroundBand.min}-${backgroundBand.max}-${backgroundBand.color}`}
          x={padding}
          y={endY}
          width={chartWidth}
          height={bandHeight}
          fill={backgroundBand.color}
        />
      );
    }) ?? [];

  return (
    <View
      style={{ width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 }}
      onLayout={onLayout}
    >
      <Svg width={currentWidth} height={currentHeight}>
        {chartBackgroundBands}
        {showBaseline && (
          <Line
            x1={padding}
            y1={avgY}
            x2={currentWidth - padding}
            y2={avgY}
            stroke={colors.surfaceSecondary}
            strokeWidth={1}
            strokeDasharray="4,4"
          />
        )}
        {segments.map((points) => (
          <Polyline
            key={points}
            points={points}
            fill="none"
            stroke={color}
            strokeWidth={lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </Svg>
    </View>
  );
}
