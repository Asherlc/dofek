import { formatDateTime } from "@dofek/format/format";
import { formatDoseStatus, medicationDoseEventSchema } from "@dofek/format/medication-dose-events";
import { StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

type MedicationDoseEventsQueryResult = {
  isLoading: boolean;
  error: { message: string } | null;
  data?: { events?: unknown } | null;
};

export function MedicationDoseEventsPanel({
  queryResult,
}: {
  queryResult?: MedicationDoseEventsQueryResult;
}) {
  const internalDoseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });
  const doseEvents = queryResult ?? internalDoseEvents;

  if (doseEvents.isLoading) {
    return <QueryStatePanel variant="loading" minHeight={96} />;
  }

  if (doseEvents.error) {
    return <QueryStatePanel variant="error" minHeight={96} message={doseEvents.error.message} />;
  }

  const events = z.array(medicationDoseEventSchema).parse(doseEvents.data?.events ?? []);
  if (events.length === 0) {
    return (
      <QueryStatePanel variant="empty" minHeight={96} message="No medication dose events yet." />
    );
  }

  return (
    <View style={styles.list}>
      {events.map((event) => (
        <View key={event.id} style={styles.row}>
          <View style={styles.rowHeader}>
            <View style={styles.titleGroup}>
              <Text style={styles.medicationName} numberOfLines={2}>
                {event.medicationName}
              </Text>
              <Text style={styles.recordedAt}>{formatDateTime(new Date(event.recordedAt))}</Text>
            </View>
            <View style={styles.statusBadge}>
              <Text style={styles.statusText}>{formatDoseStatus(event.doseStatus)}</Text>
            </View>
          </View>
          {event.sourceName ? <Text style={styles.sourceName}>{event.sourceName}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.sm,
  },
  row: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: 1,
    paddingBottom: spacing.sm,
  },
  rowHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  titleGroup: {
    flex: 1,
    gap: 4,
  },
  medicationName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  recordedAt: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  statusBadge: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  sourceName: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: spacing.xs,
  },
});
