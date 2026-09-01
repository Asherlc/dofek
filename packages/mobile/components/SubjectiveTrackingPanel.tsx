import { Pressable, StyleSheet, Text } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { Card } from "./Card";
import { QueryStatePanel } from "./QueryStatePanel";

export function SubjectiveTrackingPanel() {
  const injuries = trpc.subjective.injuries.useQuery();
  const saveCheckIn = trpc.subjective.saveCheckIn.useMutation();

  return (
    <Card>
      <Text style={styles.title}>Injuries and niggles</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All clear today"
        disabled={saveCheckIn.isPending}
        onPress={() =>
          saveCheckIn.mutate({ date: new Date().toISOString().slice(0, 10), symptoms: [] })
        }
        style={styles.checkInButton}
      >
        <Text style={styles.checkInText}>All clear today</Text>
      </Pressable>
      {saveCheckIn.error ? <Text style={styles.error}>{saveCheckIn.error.message}</Text> : null}
      {injuries.isLoading && injuries.data === undefined ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : injuries.error && injuries.data === undefined ? (
        <QueryStatePanel variant="error" message={injuries.error.message} minHeight={96} />
      ) : injuries.data?.length ? (
        injuries.data.map((injury) => (
          <Text key={injury.id} style={styles.injury}>
            {injury.kind}: {injury.description} (
            {injury.severity == null ? "severity not recorded" : `${injury.severity}/10`})
          </Text>
        ))
      ) : (
        <Text style={styles.emptyState}>No injury events logged.</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  emptyState: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  injury: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  checkInButton: { alignSelf: "flex-start", borderColor: colors.border, borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 6 },
  checkInText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 12, marginTop: 4 },
});
