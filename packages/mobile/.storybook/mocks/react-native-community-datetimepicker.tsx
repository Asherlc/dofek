import { Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../../theme";

interface StorybookDateTimePickerProps {
  accessibilityLabel?: string;
  value: Date;
}

export default function StorybookDateTimePicker({
  accessibilityLabel,
  value,
}: StorybookDateTimePickerProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={styles.picker}
    >
      <Text style={styles.text}>
        {value.toLocaleDateString("en-CA", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  picker: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  text: {
    color: colors.text,
    fontSize: 14,
  },
});
