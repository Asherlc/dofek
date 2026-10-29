import { mapAttributionText } from "@dofek/training/map-style";
import { StyleSheet, Text } from "react-native";
import { colors } from "../theme";

export function MapAttribution() {
  return <Text style={styles.text}>{mapAttributionText}</Text>;
}

const styles = StyleSheet.create({
  text: { color: colors.textSecondary, fontSize: 9 },
});
