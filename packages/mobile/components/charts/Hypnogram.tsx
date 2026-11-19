import { formatDurationSeconds, formatTimeOnly } from "@dofek/format/format";
import { sleepStageColors } from "@dofek/scoring/colors";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Line, Rect } from "react-native-svg";
import { colors } from "../../theme";
import { AccessibleChart } from "../AccessibleChart";

interface SleepStage {
  stage: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
}

interface HypnogramProps {
  data: SleepStage[];
}

const STAGES = [
  { key: "awake", label: "Awake", color: sleepStageColors.awake },
  { key: "rem", label: "REM", color: sleepStageColors.rem },
  { key: "light", label: "Light", color: sleepStageColors.light },
  { key: "deep", label: "Deep", color: sleepStageColors.deep },
];
const PADDING = { top: 8, right: 12 };
// Nominal SVG height: 8pt top inset plus four 44pt stage lanes. The time
// anchors live in their own wrapping row below this plot, not inside it.
const PLOT_HEIGHT = 184;

export function Hypnogram({ data }: HypnogramProps) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState<SleepStage | null>(null);
  const selected = selection && data.includes(selection) ? selection : null;
  const selectedStage = STAGES.find((stage) => stage.key === selected?.stage);
  if (data.length === 0)
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No sleep stage data</Text>
      </View>
    );

  const chartWidth = layout.width - PADDING.right;
  const chartHeight = layout.height - PADDING.top;
  const laneHeight = chartHeight / 4;
  const labelLaneStyle = chartHeight > 0 ? { height: laneHeight } : undefined;
  const timeStart = Math.min(...data.map((interval) => Date.parse(interval.started_at)));
  const timeEnd = Math.max(...data.map((interval) => Date.parse(interval.ended_at)));
  const timeSpan = timeEnd - timeStart;
  const timeToX = (time: string) => ((Date.parse(time) - timeStart) / timeSpan) * chartWidth;

  return (
    <>
      <AccessibleChart
        title="Sleep stages"
        summary="Sleep stages over the recorded sleep period."
        rows={data.map((interval) => ({
          label: STAGES.find((stage) => stage.key === interval.stage)?.label ?? interval.stage,
          value: `${formatTimeOnly(interval.started_at, { seconds: true })} to ${formatTimeOnly(interval.ended_at, { seconds: true })} · ${formatDurationSeconds(interval.duration_seconds, { precision: "second" })}`,
          onPress: () => setSelection(interval),
        }))}
      >
        <View style={styles.container}>
          <View style={styles.chart}>
            <View style={styles.yLabels}>
              {STAGES.map((stage) => (
                <View key={stage.key} style={[styles.labelLane, labelLaneStyle]}>
                  <Text style={styles.axisLabel} numberOfLines={1}>
                    {stage.label}
                  </Text>
                </View>
              ))}
            </View>
            <View style={styles.plotColumn}>
              <View
                testID="sleep-stage-plot"
                style={styles.plot}
                onLayout={(event) =>
                  setLayout({
                    width: event.nativeEvent.layout.width,
                    height: event.nativeEvent.layout.height,
                  })
                }
              >
                {chartWidth > 0 && chartHeight > 0 && timeSpan > 0 && (
                  <Svg width={layout.width} height={layout.height}>
                    {STAGES.map((stage, index) => (
                      <Line
                        key={stage.key}
                        x1={0}
                        x2={chartWidth}
                        y1={PADDING.top + (index + 1) * laneHeight}
                        y2={PADDING.top + (index + 1) * laneHeight}
                        stroke={colors.surfaceSecondary}
                        strokeWidth={1}
                      />
                    ))}
                    {data.map((interval) => {
                      const stageIndex = STAGES.findIndex((stage) => stage.key === interval.stage);
                      const stage = STAGES[stageIndex];
                      if (!stage) return null;
                      const startX = timeToX(interval.started_at);
                      const blockHeight = laneHeight * 0.55;
                      return (
                        <Rect
                          key={`${interval.stage}-${interval.started_at}-${interval.ended_at}`}
                          x={startX}
                          y={PADDING.top + stageIndex * laneHeight + (laneHeight - blockHeight) / 2}
                          width={timeToX(interval.ended_at) - startX}
                          height={blockHeight}
                          rx={3}
                          fill={stage.color}
                          stroke={selected === interval ? colors.text : undefined}
                          strokeWidth={selected === interval ? 2 : 0}
                          onPress={() => setSelection(interval)}
                        />
                      );
                    })}
                  </Svg>
                )}
              </View>
              <View style={styles.xLabels}>
                <Text style={styles.axisLabel}>
                  {formatTimeOnly(new Date(timeStart).toISOString())}
                </Text>
                <Text style={styles.axisLabel}>
                  {formatTimeOnly(new Date(timeEnd).toISOString())}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </AccessibleChart>
      <View style={styles.detail} accessibilityLiveRegion="polite">
        <Text style={selected ? styles.detailText : styles.emptyText}>
          {selected && selectedStage
            ? `${selectedStage.label} · ${formatTimeOnly(selected.started_at, { seconds: true })} – ${formatTimeOnly(selected.ended_at, { seconds: true })} · ${formatDurationSeconds(selected.duration_seconds, { precision: "second" })}`
            : "Select a sleep stage to see its interval."}
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { gap: 4 },
  chart: { flexDirection: "row", gap: 8 },
  yLabels: { paddingTop: PADDING.top, flexShrink: 0 },
  labelLane: { justifyContent: "center" },
  plotColumn: { flex: 1 },
  plot: { height: PLOT_HEIGHT },
  empty: { height: 216, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 12, color: colors.textTertiary },
  axisLabel: { fontSize: 10, color: colors.textTertiary, fontVariant: ["tabular-nums"] },
  xLabels: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 2,
    marginTop: 4,
  },
  detail: {
    minHeight: 56,
    marginTop: 12,
    padding: 12,
    borderColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderRadius: 8,
    justifyContent: "center",
  },
  detailText: { fontSize: 12, color: colors.text },
});
