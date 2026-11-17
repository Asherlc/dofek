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
const PADDING = { top: 8, right: 12, bottom: 32, left: 52 };

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

  const chartWidth = layout.width - PADDING.left - PADDING.right;
  const chartHeight = layout.height - PADDING.top - PADDING.bottom;
  const laneHeight = chartHeight / 4;
  const timeStart = Math.min(...data.map((interval) => Date.parse(interval.started_at)));
  const timeEnd = Math.max(...data.map((interval) => Date.parse(interval.ended_at)));
  const timeSpan = timeEnd - timeStart;
  const timeToX = (time: string) =>
    PADDING.left + ((Date.parse(time) - timeStart) / timeSpan) * chartWidth;

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
          <View
            testID="sleep-stage-plot"
            style={styles.chart}
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
                    x1={PADDING.left}
                    x2={layout.width - PADDING.right}
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
            {STAGES.map((stage, index) => (
              <Text
                key={stage.key}
                style={[
                  styles.axisLabel,
                  styles.yLabel,
                  { top: PADDING.top + (index + 0.5) * laneHeight - 7 },
                ]}
              >
                {stage.label}
              </Text>
            ))}
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
  chart: { height: 216, position: "relative" },
  empty: { height: 216, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 12, color: colors.textTertiary },
  axisLabel: { fontSize: 10, color: colors.textTertiary, fontVariant: ["tabular-nums"] },
  yLabel: { position: "absolute", left: 0 },
  xLabels: {
    position: "absolute",
    bottom: 4,
    left: PADDING.left,
    right: PADDING.right,
    flexDirection: "row",
    justifyContent: "space-between",
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
