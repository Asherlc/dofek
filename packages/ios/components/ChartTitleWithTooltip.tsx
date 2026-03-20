import { type StyleProp, StyleSheet, Text, type TextStyle, View } from "react-native";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip";

interface ChartTitleWithTooltipProps {
  title: string;
  description: string;
  textStyle: StyleProp<TextStyle>;
}

export function ChartTitleWithTooltip({
  title,
  description,
  textStyle,
}: ChartTitleWithTooltipProps) {
  return (
    <View style={styles.row}>
      <Text style={textStyle}>{title}</Text>
      <ChartDescriptionTooltip title={title} description={description} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});
