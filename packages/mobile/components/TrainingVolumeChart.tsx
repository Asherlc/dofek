import { formatDurationMinutesClock } from "@dofek/format/format";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";
import { WeeklyVolumeBars } from "./WeeklyVolumeBars";

type ClimbingRow = { week: string; attempts: number | null; minutes: number | null };
type StrengthRow = {
  week: string;
  recordedVolumeKg: number | null;
  recordedSetCount: number | null;
  durationMinutes: number | null;
};
type Props =
  | { sport: "climbing"; data: ClimbingRow[] }
  | { sport: "strength"; data: StrengthRow[] };

export function TrainingVolumeChart(props: Props) {
  const units = useUnitConverter();
  const [metric, setMetric] = useState("primary");
  const options =
    props.sport === "climbing"
      ? [
          { key: "primary", label: "Attempts" },
          { key: "time", label: "Time" },
        ]
      : [
          { key: "primary", label: "Weight lifted" },
          { key: "sets", label: "Sets" },
          { key: "time", label: "Time" },
        ];
  const values =
    props.sport === "climbing"
      ? props.data.map((row) => (metric === "time" ? row.minutes : row.attempts))
      : props.data.map((row) =>
          metric === "time"
            ? row.durationMinutes
            : metric === "sets"
              ? row.recordedSetCount
              : row.recordedVolumeKg == null
                ? null
                : units.convertWeight(row.recordedVolumeKg),
        );
  const showHoursMinutes =
    props.sport === "climbing" &&
    metric === "time" &&
    values.some((value) => value != null && value >= 60);
  const unit = showHoursMinutes
    ? "hours:minutes"
    : metric === "time"
      ? "minutes"
      : props.sport === "strength" && metric === "primary"
        ? units.weightLabel
        : metric === "sets"
          ? "sets"
          : "attempts";
  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {props.sport === "climbing" ? "Climbing Volume" : "Strength Volume"}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Volume metric"
        style={styles.options}
      >
        {options.map((option) => (
          <TouchableOpacity
            key={option.key}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: metric === option.key }}
            onPress={() => setMetric(option.key)}
            style={styles.option}
          >
            <Text style={{ color: metric === option.key ? colors.accent : colors.textSecondary }}>
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {props.data.length ? (
        <>
          <Text style={styles.text}>{unit} per week</Text>
          <WeeklyVolumeBars
            weeks={props.data.map((row, index) => ({
              week: row.week,
              value: values[index] ?? null,
            }))}
            unit={unit}
            formatValue={showHoursMinutes ? formatDurationMinutesClock : undefined}
          />
        </>
      ) : (
        <Text style={styles.text}>No volume data for this period</Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: 16, marginBottom: 16, backgroundColor: colors.surface, borderRadius: 12 },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  options: { flexDirection: "row", gap: 8 },
  option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  text: { color: colors.textSecondary },
});
