import { mapAttribution } from "@dofek/training/map-style";
import { StyleSheet, Text } from "react-native";
import { colors } from "../theme";

export function MapAttribution() {
  return <Text style={styles.text}>{mapAttribution.replace(/<[^>]*>/g, "")}</Text>;
}

const styles = StyleSheet.create({
  text: { color: colors.textSecondary, fontSize: 9 },
});
