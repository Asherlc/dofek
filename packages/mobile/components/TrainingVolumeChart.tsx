import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

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
              : row.recordedVolumeKg,
        );
  const unit =
    metric === "time"
      ? "minutes"
      : props.sport === "strength" && metric === "primary"
        ? "kg"
        : metric === "sets"
          ? "sets"
          : "attempts";
  const max = Math.max(0, ...values.filter((value): value is number => value !== null));
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
          {props.data.map((row, index) => (
            <View
              key={row.week}
              style={styles.row}
              accessibilityLabel={`${row.week}: ${values[index] == null ? "Not recorded" : `${values[index]} ${unit}`}`}
            >
              <Text style={styles.text}>{row.week}</Text>
              <View style={styles.track}>
                <View
                  style={[
                    styles.bar,
                    { width: `${max === 0 ? 0 : ((values[index] ?? 0) / max) * 100}%` },
                  ]}
                />
              </View>
              <Text style={styles.text}>{values[index] == null ? "—" : values[index]}</Text>
            </View>
          ))}
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
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  track: { flex: 1, height: 8, backgroundColor: colors.surfaceSecondary, borderRadius: 4 },
  bar: { height: 8, backgroundColor: colors.accent, borderRadius: 4 },
});
