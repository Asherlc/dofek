import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export interface DayOption {
  label: string;
  value: number;
}

export const DEFAULT_DAY_OPTIONS: DayOption[] = [
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

export function DaySelector({
  days,
  onChange,
  options = DEFAULT_DAY_OPTIONS,
}: {
  days: number;
  onChange: (days: number) => void;
  options?: DayOption[];
}) {
  return (
    <View style={styles.row}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={[styles.button, days === opt.value && styles.buttonActive]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.7}
        >
          <Text style={[styles.text, days === opt.value && styles.textActive]}>{opt.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  buttonActive: {
    backgroundColor: colors.accent,
  },
  text: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  textActive: {
    color: colors.text,
  },
});
