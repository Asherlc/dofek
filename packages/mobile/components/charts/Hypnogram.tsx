import { sleepStageColors } from "@dofek/scoring/colors";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Line, Polyline, Rect } from "react-native-svg";
import { colors } from "../../theme";

interface SleepStage {
  stage: string;
  started_at: string;
  ended_at: string;
}

interface HypnogramProps {
  data: SleepStage[];
}

const STAGE_VALUE: Record<string, number> = {
  awake: 0,
  rem: 1,
  light: 2,
  deep: 3,
};

const STAGE_LABEL = ["Awake", "REM", "Light", "Deep"];

const STAGE_COLOR: Record<string, string> = {
  awake: sleepStageColors.awake,
  rem: sleepStageColors.rem,
  light: sleepStageColors.light,
  deep: sleepStageColors.deep,
};

const PADDING = { top: 8, right: 12, bottom: 24, left: 44 };

export function Hypnogram({ data }: HypnogramProps) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });

  if (data.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No sleep stage data</Text>
      </View>
    );
  }

  const chartWidth = layout.width - PADDING.left - PADDING.right;
  const chartHeight = layout.height - PADDING.top - PADDING.bottom;

  const firstStage = data[0];
  const lastStage = data[data.length - 1];
  const timeStart = new Date(firstStage?.started_at ?? "").getTime();
  const timeEnd = new Date(lastStage?.ended_at ?? "").getTime();
  const timeSpan = timeEnd - timeStart;

  function timeToX(time: string): number {
    const ms = new Date(time).getTime() - timeStart;
    return PADDING.left + (ms / timeSpan) * chartWidth;
  }

  function stageToY(stage: string): number {
    const value = STAGE_VALUE[stage] ?? 2;
    return PADDING.top + (value / 3) * chartHeight;
  }

  // Build step-chart polyline points
  const points: string[] = [];
  for (const stage of data) {
    const x1 = timeToX(stage.started_at);
    const x2 = timeToX(stage.ended_at);
    const stageY = stageToY(stage.stage);
    points.push(`${x1},${stageY}`);
    points.push(`${x2},${stageY}`);
  }

  // Build colored rectangles for each stage
  const rects = data.map((stage) => {
    const x1 = timeToX(stage.started_at);
    const x2 = timeToX(stage.ended_at);
    const rectY = stageToY(stage.stage);
    const color = STAGE_COLOR[stage.stage] ?? "#78909C";
    return (
      <Rect
        key={stage.started_at}
        x={x1}
        y={rectY}
        width={Math.max(x2 - x1, 0.5)}
        height={chartHeight - rectY + PADDING.top}
        fill={color}
        opacity={0.15}
      />
    );
  });

  // Time labels (start and end)
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <View style={styles.container}>
      <View
        style={styles.chart}
        onLayout={(e) =>
          setLayout({
            width: e.nativeEvent.layout.width,
            height: e.nativeEvent.layout.height,
          })
        }
      >
        {layout.width > 0 && layout.height > 0 && (
          <Svg width={layout.width} height={layout.height}>
            {/* Grid lines for each stage */}
            {STAGE_LABEL.map((stageLabel, i) => {
              const gridY = PADDING.top + (i / 3) * chartHeight;
              return (
                <Line
                  key={stageLabel}
                  x1={PADDING.left}
                  y1={gridY}
                  x2={layout.width - PADDING.right}
                  y2={gridY}
                  stroke={colors.surfaceSecondary}
                  strokeWidth={0.5}
                />
              );
            })}

            {/* Colored fill areas */}
            {rects}

            {/* Step line */}
            <Polyline
              points={points.join(" ")}
              fill="none"
              stroke={colors.textSecondary}
              strokeWidth={2}
            />
          </Svg>
        )}
      </View>

      {/* Y-axis labels */}
      <View style={[styles.yAxisLabels, { top: PADDING.top }]}>
        {STAGE_LABEL.map((label, i) => (
          <Text
            key={label}
            style={[
              styles.axisLabel,
              {
                position: "absolute",
                top: chartHeight > 0 ? (i / 3) * chartHeight - 6 : 0,
                left: 0,
              },
            ]}
          >
            {label}
          </Text>
        ))}
      </View>

      {/* X-axis labels */}
      <View style={styles.xAxisLabels}>
        <Text style={styles.axisLabel}>{firstStage ? formatTime(firstStage.started_at) : ""}</Text>
        <Text style={styles.axisLabel}>{lastStage ? formatTime(lastStage.ended_at) : ""}</Text>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {Object.entries(STAGE_COLOR).map(([stage, color]) => (
          <View key={stage} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={styles.legendText}>{STAGE_LABEL[STAGE_VALUE[stage] ?? 0]}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
  },
  chart: {
    height: 140,
    position: "relative",
  },
  empty: {
    height: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  yAxisLabels: {
    position: "absolute",
    left: 0,
    width: PADDING.left - 4,
  },
  xAxisLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: PADDING.left,
  },
  axisLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    fontVariant: ["tabular-nums"],
  },
  legend: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 14,
    marginTop: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 10,
    color: colors.textTertiary,
  },
});
