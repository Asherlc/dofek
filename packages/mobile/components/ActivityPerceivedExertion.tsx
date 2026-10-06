import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export function ActivityPerceivedExertion({ value }: { value: number | null }) {
  if (value == null) return null;

  return (
    <View style={styles.container} accessibilityLabel="Session perceived exertion">
      <Text style={styles.title}>Session effort</Text>
      <Text style={styles.value}>{value}/10</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 6 },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  value: { color: colors.text, fontSize: 20, fontWeight: "700", marginTop: 8 },
});
