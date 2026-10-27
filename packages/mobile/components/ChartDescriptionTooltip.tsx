import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../theme";

interface ChartDescriptionTooltipProps {
  title: string;
  description: string;
}

export function ChartDescriptionTooltip({ title, description }: ChartDescriptionTooltipProps) {
  const [pressed, setPressed] = useState(false);

  return (
    <Pressable
      onPress={() => Alert.alert(title, description, [{ text: "Close" }])}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={`About ${title}`}
      accessibilityHint={description}
      style={styles.button}
    >
      <Text style={[styles.text, pressed && styles.textPressed]}>About</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.textTertiary,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: "700",
  },
  textPressed: {
    opacity: 0.7,
  },
});
