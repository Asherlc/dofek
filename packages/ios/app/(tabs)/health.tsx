import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { requestPermissions } from "../../modules/health-kit";

// TODO: Implement HealthKit integration via Expo Modules API (native Swift module)
// TODO: Show sync status, last sync time, data types being synced
// TODO: Add toggle for background sync
// TODO: Show count of samples synced per data type

export default function HealthScreen() {
  async function handleRequestPermissions() {
    const granted = await requestPermissions();
    if (!granted) {
      // TODO: Show alert explaining why permissions are needed
      console.log("HealthKit permissions not granted");
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>HealthKit Sync</Text>
      <Text style={styles.placeholder}>HealthKit integration coming soon.</Text>
      <Text style={styles.hint}>
        This screen will let you connect Apple Health to sync heart rate, HRV, steps, sleep, and
        other health data to the Dofek server.
      </Text>

      <TouchableOpacity style={styles.button} onPress={handleRequestPermissions} activeOpacity={0.7}>
        <Text style={styles.buttonText}>Request HealthKit Permissions</Text>
      </TouchableOpacity>

      <View style={styles.statusSection}>
        <Text style={styles.statusLabel}>Sync Status</Text>
        <Text style={styles.statusValue}>Not configured</Text>
      </View>

      <View style={styles.statusSection}>
        <Text style={styles.statusLabel}>Last Sync</Text>
        <Text style={styles.statusValue}>Never</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8f9fa",
    alignItems: "center",
    padding: 24,
    paddingTop: 48,
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
    marginBottom: 32,
  },
  button: {
    backgroundColor: "#007AFF",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 32,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  statusSection: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  statusLabel: {
    fontSize: 16,
    color: "#333",
  },
  statusValue: {
    fontSize: 16,
    color: "#999",
  },
});
