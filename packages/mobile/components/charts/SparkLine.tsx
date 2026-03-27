import { useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";

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
}

/** Split data into contiguous non-null segments for gap rendering */
function splitSegments(
  data: (number | null)[],
  padding: number,
  chartWidth: number,
  chartHeight: number,
  min: number,
  range: number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value != null) {
      const pointX = padding + (i / (data.length - 1)) * chartWidth;
      const pointY = padding + chartHeight - ((value - min) / range) * chartHeight;
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

  const min = Math.min(...nonNullValues);
  const max = Math.max(...nonNullValues);
  const range = max - min || 1;

  const segments = splitSegments(data, padding, chartWidth, chartHeight, min, range);

  const avg = nonNullValues.reduce((sum, v) => sum + v, 0) / nonNullValues.length;
  const avgY = padding + chartHeight - ((avg - min) / range) * chartHeight;

  return (
    <View
      style={{ width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 }}
      onLayout={onLayout}
    >
      <Svg width={currentWidth} height={currentHeight}>
        {showBaseline && (
          <Line
            x1={padding}
            y1={avgY}
            x2={currentWidth - padding}
            y2={avgY}
            stroke="#3a3a3e"
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
