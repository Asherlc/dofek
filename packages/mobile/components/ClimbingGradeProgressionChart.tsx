import {
  type ClimbingGradeProgressionLane,
  climbingProgressionGradeColor,
  climbingProgressionLaneLabel,
  climbingProgressionPeriodLabel,
  climbingProgressionSettingLabels,
  climbingProgressionSettings,
  climbingProgressionValueLabel,
} from "@dofek/training/climbing-progression";
import { useId, useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, G, Line, Pattern, Rect, Text as SvgText } from "react-native-svg";
import { colors } from "../theme";
import { AccessibleChart } from "./AccessibleChart";

interface Props {
  data: ClimbingGradeProgressionLane[];
  loading?: boolean;
}

function laneKey(lane: ClimbingGradeProgressionLane) {
  return `${lane.style}:${lane.gradeSystem}`;
}

export function ClimbingGradeProgressionChart({ data, loading }: Props) {
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedSetting, setSelectedSetting] = useState("all");
  const focused = data.find((lane) => laneKey(lane) === focusedKey);
  const visible = focused ? [focused] : data;
  const setting = focused?.settings.some((value) => value === selectedSetting)
    ? selectedSetting
    : "all";
  const availableSettings = climbingProgressionSettings.filter((setting) =>
    visible.some((lane) => lane.settings.includes(setting)),
  );
  if (data.length === 0)
    return (
      <Text style={styles.empty}>
        {loading ? "Loading climbing grades…" : "No recorded climbing grades"}
      </Text>
    );

  return (
    <View style={styles.stack}>
      <Text style={styles.caption}>Sends per climbing day</Text>
      {focused ? (
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="All styles"
            style={styles.button}
            onPress={() => {
              setFocusedKey(null);
              setSelectedSetting("all");
            }}
          >
            <Text style={styles.buttonText}>All styles</Text>
          </Pressable>
          {[
            { value: "all", label: "All settings", accessibilityLabel: "All settings" },
            ...focused.settings.map((value) => ({
              value,
              label: climbingProgressionSettingLabels[value],
              accessibilityLabel: climbingProgressionSettingLabels[value],
            })),
          ].map(({ value, label, accessibilityLabel }) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              accessibilityState={{ selected: setting === value }}
              style={[styles.button, setting === value && styles.selectedButton]}
              onPress={() => setSelectedSetting(value)}
            >
              <Text style={styles.buttonText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.legend}>
          {availableSettings.map((setting) => (
            <Text key={setting} style={styles.caption}>
              {setting === "indoor" ? "■" : setting === "outdoor" ? "▨" : "▦"}{" "}
              {climbingProgressionSettingLabels[setting]}
            </Text>
          ))}
        </View>
      )}
      {visible.map((lane) => (
        <ClimbingLane
          key={laneKey(lane)}
          lane={lane}
          label={climbingProgressionLaneLabel(lane, data)}
          setting={setting}
          focused={Boolean(focused)}
          onFocus={() => {
            setFocusedKey(laneKey(lane));
            setSelectedSetting("all");
          }}
        />
      ))}
    </View>
  );
}

function ClimbingLane({
  lane,
  label,
  setting,
  focused,
  onFocus,
}: {
  lane: ClimbingGradeProgressionLane;
  label: string;
  setting: string;
  focused: boolean;
  onFocus: () => void;
}) {
  const [width, setWidth] = useState(0);
  const [selectedPeriodStart, setSelectedPeriodStart] = useState<string | null>(null);
  const selectedPeriod = lane.periods.find((period) => period.startDate === selectedPeriodStart);
  const patternId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const settings = lane.settings.filter((value) => setting === "all" || value === setting);
  const plotHeight = focused ? 210 : 125;
  const left = 28;
  const top = 12;
  const baseline = top + plotHeight;
  const plotWidth = Math.max(0, width - left - 8);
  const periodWidth = plotWidth / lane.periods.length;
  const barWidth =
    periodWidth * (settings.length === 1 ? 0.4 : settings.length === 2 ? 0.22 : 0.16);
  const barGap = barWidth * 0.2;
  const groupWidth = barWidth * settings.length + barGap * (settings.length - 1);
  const scaleY = (value: number) => baseline - (value / lane.axisMax) * plotHeight;
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const rows = lane.periods.flatMap((period) =>
    period.settings
      .filter((point) => settings.includes(point.setting))
      .flatMap((point) => {
        const periodLabel = `${climbingProgressionPeriodLabel(period, true)} · ${climbingProgressionSettingLabels[point.setting]}`;
        return point.sendsPerDay === null
          ? [{ label: periodLabel, value: "No recorded days" }]
          : point.segments.map((segment) => ({
              label: `${periodLabel} · ${segment.grade}`,
              value: climbingProgressionValueLabel(point, segment),
            }));
      }),
  );

  return (
    <View style={styles.lane}>
      <View style={styles.laneHeader}>
        <Text style={styles.title}>{label}</Text>
        {!focused && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Focus ${label}`}
            onPress={onFocus}
            style={styles.focusButton}
          >
            <Text style={styles.buttonText}>Focus ↗</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.legend}>
        {lane.grades.map(({ grade }, index) => (
          <View key={grade} style={styles.gradeLegend}>
            <View
              style={[
                styles.swatch,
                { backgroundColor: climbingProgressionGradeColor(index, lane.grades.length) },
              ]}
            />
            <Text style={styles.caption}>{grade}</Text>
          </View>
        ))}
      </View>
      <AccessibleChart title={label} summary="Sends per climbing day" rows={rows}>
        <View onLayout={onLayout} style={{ height: baseline + 30 }}>
          {width > 0 && (
            <Svg width={width} height={baseline + 30}>
              <Defs>
                <Pattern
                  id={`${patternId}outdoor`}
                  width={6}
                  height={6}
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <Line
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={6}
                    stroke="#0f172a"
                    strokeOpacity={0.45}
                    strokeWidth={1}
                  />
                </Pattern>
                <Pattern
                  id={`${patternId}unknown`}
                  width={6}
                  height={6}
                  patternUnits="userSpaceOnUse"
                >
                  <Circle cx={2} cy={2} r={0.7} fill="#0f172a" fillOpacity={0.55} />
                </Pattern>
              </Defs>
              {lane.axisTicks.map((tick) => (
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
              {lane.periods.map((period, periodIndex) => {
                const center = left + periodWidth * (periodIndex + 0.5);
                return (
                  <G key={period.startDate}>
                    {settings.map((setting, settingIndex) => {
                      const point = period.settings.find((point) => point.setting === setting);
                      const barX = center - groupWidth / 2 + settingIndex * (barWidth + barGap);
                      return (
                        <G key={setting}>
                          {point?.segments.map((segment, gradeIndex) =>
                            segment.stackStart !== null && segment.stackEnd !== null ? (
                              <Rect
                                key={segment.grade}
                                x={barX}
                                y={scaleY(segment.stackEnd)}
                                width={barWidth}
                                height={
                                  ((segment.stackEnd - segment.stackStart) / lane.axisMax) *
                                  plotHeight
                                }
                                fill={climbingProgressionGradeColor(gradeIndex, lane.grades.length)}
                              />
                            ) : null,
                          )}
                          {point?.sendsPerDay != null &&
                            point.sendsPerDay > 0 &&
                            setting !== "indoor" && (
                              <Rect
                                x={barX}
                                y={scaleY(point.sendsPerDay)}
                                width={barWidth}
                                height={(point.sendsPerDay / lane.axisMax) * plotHeight}
                                fill={`url(#${patternId}${setting})`}
                              />
                            )}
                          {(point?.sendsPerDay == null || point.sendsPerDay === 0) && (
                            <SvgText
                              x={barX + barWidth / 2}
                              y={baseline - 5}
                              textAnchor="middle"
                              fill={colors.textTertiary}
                              fontSize={11}
                            >
                              {point?.sendsPerDay === 0 ? "0" : "—"}
                            </SvgText>
                          )}
                        </G>
                      );
                    })}
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
          <View style={styles.laneHeader}>
            <Text style={styles.title}>{climbingProgressionPeriodLabel(selectedPeriod, true)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close period details"
              style={styles.focusButton}
              onPress={() => setSelectedPeriodStart(null)}
            >
              <Text style={styles.buttonText}>Close</Text>
            </Pressable>
          </View>
          {selectedPeriod.settings
            .filter((point) => settings.includes(point.setting))
            .map((point) => (
              <View key={point.setting} style={styles.stack}>
                <Text style={styles.title}>{climbingProgressionSettingLabels[point.setting]}</Text>
                <Text style={styles.caption}>{climbingProgressionValueLabel(point)}</Text>
                {point.segments
                  .filter((segment) => segment.sends > 0)
                  .map((segment) => (
                    <Text key={segment.grade} style={styles.caption}>
                      {segment.grade}: {climbingProgressionValueLabel(point, segment)}
                    </Text>
                  ))}
              </View>
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
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  gradeLegend: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  button: {
    minHeight: 44,
    paddingHorizontal: 10,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    borderRadius: 8,
  },
  selectedButton: { borderColor: colors.accent },
  buttonText: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  focusButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  lane: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceSecondary,
    paddingTop: 8,
    gap: 4,
  },
  laneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  details: { padding: 12, backgroundColor: colors.surfaceSecondary, borderRadius: 8, gap: 12 },
});
