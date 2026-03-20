import { Alert, Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../theme";

interface ChartDescriptionTooltipProps {
  title: string;
  description: string;
}

export function ChartDescriptionTooltip({ title, description }: ChartDescriptionTooltipProps) {
  return (
    <Pressable
      onPress={() => Alert.alert(title, description)}
      accessibilityRole="button"
      accessibilityLabel={`Chart info for ${title}`}
      accessibilityHint={description}
      hitSlop={8}
      style={styles.button}
    >
      <Text style={styles.text}>i</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.textTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: "700",
    marginTop: -1,
  },
});
