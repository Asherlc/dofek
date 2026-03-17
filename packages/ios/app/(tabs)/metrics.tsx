import { StyleSheet, Text, View, useWindowDimensions } from "react-native";

// TODO: Add charts for weight, heart rate, HRV, resting HR, sleep, etc.
// TODO: Use tRPC queries to fetch metric data from the server
// TODO: Consider using react-native-chart-kit or victory-native for charts

export default function MetricsScreen() {
  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  return (
    <View style={styles.container}>
      <View style={[styles.innerContainer, isWide && styles.innerContainerWide]}>
        <Text style={styles.title}>Metrics</Text>
        <Text style={styles.placeholder}>Charts and health metrics coming soon.</Text>
        <Text style={styles.hint}>
          This screen will show trends for weight, heart rate, HRV, and other health data synced from
          your providers.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8f9fa",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  innerContainer: {
    alignItems: "center",
  },
  innerContainerWide: {
    maxWidth: 600,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#1a1a1a",
    marginBottom: 12,
  },
  placeholder: {
    fontSize: 16,
    color: "#666",
    textAlign: "center",
    marginBottom: 8,
  },
  hint: {
    fontSize: 14,
    color: "#999",
    textAlign: "center",
    lineHeight: 20,
  },
});
