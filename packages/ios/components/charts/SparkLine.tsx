import { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";

interface SparkLineProps {
  /** Data points to plot */
  data: number[];
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

  if (data.length < 2 || currentWidth === 0 || currentHeight === 0) {
    return <View style={{ width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 }} onLayout={onLayout} />;
  }

  const padding = 2;
  const chartWidth = currentWidth - padding * 2;
  const chartHeight = currentHeight - padding * 2;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data
    .map((value, index) => {
      const x = padding + (index / (data.length - 1)) * chartWidth;
      const y = padding + chartHeight - ((value - min) / range) * chartHeight;
      return `${x},${y}`;
    })
    .join(" ");

  const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
  const avgY = padding + chartHeight - ((avg - min) / range) * chartHeight;

  return (
    <View style={{ width: fixedWidth, height: fixedHeight, flex: fixedWidth ? undefined : 1 }} onLayout={onLayout}>
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
        <Polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}
