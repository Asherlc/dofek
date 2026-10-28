import {
  type ClimbingGradeProgressionData,
  climbingProgressionGradeColor,
  climbingProgressionGradeLabel,
  climbingProgressionPeriodLabel,
  climbingProgressionValueLabel,
} from "@dofek/training/climbing-progression";
import { useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { G, Line, Rect, Text as SvgText } from "react-native-svg";
import { colors } from "../theme";
import { AccessibleChart } from "./AccessibleChart";

interface Props {
  data: ClimbingGradeProgressionData | null;
  loading?: boolean;
}

export function ClimbingGradeProgressionChart({ data, loading }: Props) {
  const [width, setWidth] = useState(0);
  const [selectedPeriodStart, setSelectedPeriodStart] = useState<string | null>(null);
  if (data === null)
    return (
      <Text style={styles.empty}>
        {loading ? "Loading climbing grades…" : "No recorded climbing grades"}
      </Text>
    );

  const selectedPeriod = data.periods.find((period) => period.startDate === selectedPeriodStart);
  const plotHeight = 180;
  const left = 28;
  const top = 12;
  const baseline = top + plotHeight;
  const plotWidth = Math.max(0, width - left - 8);
  const periodWidth = plotWidth / data.periods.length;
  const barWidth = periodWidth * 0.4;
  const scaleY = (value: number) => baseline - (value / data.axisMax) * plotHeight;
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const gradeLabel = (gradeKey: string) => {
    const grade = data.grades.find((grade) => grade.key === gradeKey);
    return grade ? climbingProgressionGradeLabel(grade, data.grades) : gradeKey;
  };
  const rows = data.periods.flatMap((period) => {
    const periodLabel = climbingProgressionPeriodLabel(period, true);
    return period.sendsPerDay === null
      ? [{ label: periodLabel, value: "No recorded days" }]
      : period.segments.map((segment) => ({
          label: `${periodLabel} · ${gradeLabel(segment.gradeKey)}`,
          value: climbingProgressionValueLabel(period, segment),
        }));
  });

  return (
    <View style={styles.stack}>
      <Text style={styles.caption}>Sends per climbing day</Text>
      <View style={styles.legend}>
        {data.grades.map((grade, index) => (
          <View key={grade.key} style={styles.gradeLegend}>
            <View
              style={[
                styles.swatch,
                { backgroundColor: climbingProgressionGradeColor(index, data.grades.length) },
              ]}
            />
            <Text style={styles.caption}>{climbingProgressionGradeLabel(grade, data.grades)}</Text>
          </View>
        ))}
      </View>
      <AccessibleChart title="Grade progression" summary="Sends per climbing day" rows={rows}>
        <View onLayout={onLayout} style={{ height: baseline + 30 }}>
          {width > 0 && (
            <Svg width={width} height={baseline + 30}>
              {data.axisTicks.map((tick) => (
                <G key={tick}>
                  <Line
                    x1={left}
                    x2={width - 8}
                    y1={scaleY(tick)}
                    y2={scaleY(tick)}
                    stroke={colors.surfaceSecondary}
                  />
                  <SvgText
                    x={left - 6}
                    y={scaleY(tick) + 4}
                    textAnchor="end"
                    fill={colors.textTertiary}
                    fontSize={11}
                  >
                    {tick}
                  </SvgText>
                </G>
              ))}
              {data.periods.map((period, periodIndex) => {
                const center = left + periodWidth * (periodIndex + 0.5);
                return (
                  <G key={period.startDate}>
                    {period.segments.map((segment) => {
                      const gradeIndex = data.grades.findIndex(
                        (grade) => grade.key === segment.gradeKey,
                      );
                      return segment.stackStart !== null && segment.stackEnd !== null ? (
                        <Rect
                          key={segment.gradeKey}
                          x={center - barWidth / 2}
                          y={scaleY(segment.stackEnd)}
                          width={barWidth}
                          height={
                            ((segment.stackEnd - segment.stackStart) / data.axisMax) * plotHeight
                          }
                          fill={climbingProgressionGradeColor(gradeIndex, data.grades.length)}
                        />
                      ) : null;
                    })}
                    {(period.sendsPerDay === null || period.sendsPerDay === 0) && (
                      <SvgText
                        x={center}
                        y={baseline - 5}
                        textAnchor="middle"
                        fill={colors.textTertiary}
                        fontSize={11}
                      >
                        {period.sendsPerDay === 0 ? "0" : "—"}
                      </SvgText>
                    )}
                    <SvgText
                      x={center}
                      y={baseline + 19}
                      textAnchor="middle"
                      fill={colors.textSecondary}
                      fontSize={11}
                    >
                      {climbingProgressionPeriodLabel(period)}
                    </SvgText>
                    <Rect
                      x={center - periodWidth / 2}
                      y={top}
                      width={periodWidth}
                      height={plotHeight + 25}
                      fill="transparent"
                      onPress={() => setSelectedPeriodStart(period.startDate)}
                    />
                  </G>
                );
              })}
            </Svg>
          )}
        </View>
      </AccessibleChart>
      {selectedPeriod && (
        <View style={styles.details}>
          <View style={styles.detailsHeader}>
            <Text style={styles.title}>{climbingProgressionPeriodLabel(selectedPeriod, true)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close period details"
              style={styles.closeButton}
              onPress={() => setSelectedPeriodStart(null)}
            >
              <Text style={styles.buttonText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.caption}>{climbingProgressionValueLabel(selectedPeriod)}</Text>
          {selectedPeriod.segments
            .filter((segment) => segment.sends > 0)
            .map((segment) => (
              <Text key={segment.gradeKey} style={styles.caption}>
                {gradeLabel(segment.gradeKey)}:{" "}
                {climbingProgressionValueLabel(selectedPeriod, segment)}
              </Text>
            ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  caption: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  title: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  empty: { color: colors.textTertiary, fontSize: 13, paddingVertical: 24, textAlign: "center" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  gradeLegend: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  buttonText: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  closeButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  detailsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  details: { padding: 12, backgroundColor: colors.surfaceSecondary, borderRadius: 8, gap: 12 },
});
