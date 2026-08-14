import { Pressable, StyleSheet, Text } from "react-native";
import { colors, fontSize, radius, spacing } from "../../theme";

interface StorybookDateTimePickerEvent {
  type: "set";
  nativeEvent: {
    timestamp: number;
    utcOffset: number;
  };
}

interface StorybookDateTimePickerProps {
  accessibilityLabel?: string;
  onChange?: (event: StorybookDateTimePickerEvent, date?: Date) => void;
  value: Date;
}

export default function StorybookDateTimePicker({
  accessibilityLabel,
  onChange,
  value,
}: StorybookDateTimePickerProps) {
  const selectPreviousDay = () => {
    const selectedDate = new Date(value);
    selectedDate.setDate(selectedDate.getDate() - 1);
    onChange?.(
      {
        type: "set",
        nativeEvent: {
          timestamp: selectedDate.getTime(),
          utcOffset: selectedDate.getTimezoneOffset(),
        },
      },
      selectedDate,
    );
  };

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={selectPreviousDay}
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
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  text: {
    color: colors.text,
    fontSize: fontSize.base,
  },
});
