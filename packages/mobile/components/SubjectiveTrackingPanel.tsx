import { StyleSheet, Text } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { Card } from "./Card";
import { QueryStatePanel } from "./QueryStatePanel";

export function SubjectiveTrackingPanel() {
  const injuries = trpc.subjective.injuries.useQuery();

  return (
    <Card>
      <Text style={styles.title}>Injuries and niggles</Text>
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
});
