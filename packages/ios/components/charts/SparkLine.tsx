import { View } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";

interface SparkLineProps {
  /** Data points to plot */
  data: number[];
  /** Width of the chart */
  width?: number;
  /** Height of the chart */
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
  width = 120,
  height = 40,
  color = "#00E676",
  lineWidth = 2,
  showBaseline = false,
}: SparkLineProps) {
  if (data.length < 2) {
    return <View style={{ width, height }} />;
  }

  const padding = 2;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

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
    <Svg width={width} height={height}>
      {showBaseline && (
        <Line
          x1={padding}
          y1={avgY}
          x2={width - padding}
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
  );
}
