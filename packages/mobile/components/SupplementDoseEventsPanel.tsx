import { formatDateTime } from "@dofek/format/format";
import {
  formatSupplementDoseStatus,
  type SupplementDoseOccurrence,
} from "@dofek/format/supplement-dose-events";
import { StyleSheet, Text, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

export function SupplementDoseEventsPanel() {
  const query = trpc.supplements.occurrences.useQuery({ days: 7 });

  const hasCachedOccurrences = query.data !== undefined;
  if (query.isLoading && !hasCachedOccurrences) {
    return <QueryStatePanel variant="loading" minHeight={96} />;
  }
  if (query.error && !hasCachedOccurrences) {
    return <QueryStatePanel variant="error" minHeight={96} message={query.error.message} />;
  }
  if (!query.data || query.data.occurrences.length === 0) {
    if (query.error) {
      return <QueryStatePanel variant="error" minHeight={96} message={query.error.message} />;
    }
    return (
      <QueryStatePanel
        variant="empty"
        minHeight={96}
        message="No supplement dose occurrences in the last 7 days."
      />
    );
  }

  const { counts, occurrences } = query.data;
  return (
    <View style={styles.list}>
      {query.error ? (
        <QueryStatePanel variant="error" minHeight={72} message={query.error.message} />
      ) : null}
      <Text style={styles.counts}>
        Taken {counts.taken} · Skipped {counts.skipped} · Unknown {counts.unknown} · Planned{" "}
        {counts.planned}
      </Text>
      {occurrences.map((occurrence) => (
        <OccurrenceRow
          key={`${occurrence.scheduleId}:${occurrence.scheduledDate}`}
          occurrence={occurrence}
        />
      ))}
    </View>
  );
}

function OccurrenceRow({ occurrence }: { occurrence: SupplementDoseOccurrence }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.titleGroup}>
          <Text style={styles.name}>{occurrence.supplementName}</Text>
          <Text style={styles.date}>{occurrence.scheduledDate}</Text>
          <Text style={styles.detail}>
            {formatSupplementDoseStatus(occurrence.status)} · {occurrence.history.length}{" "}
            {occurrence.history.length === 1 ? "event" : "events"}
          </Text>
        </View>
      </View>
      <View accessibilityLabel={`${occurrence.supplementName} history`} style={styles.history}>
        {occurrence.history.map((event) => (
          <Text key={event.id} style={styles.source}>
            {formatSupplementDoseStatus(event.status)} · {event.sourceName ?? event.providerId} ·{" "}
            {formatDateTime(new Date(event.recordedAt))}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  counts: { color: colors.textTertiary, fontSize: 12 },
  row: {
    borderBottomColor: colors.surfaceSecondary,
    borderBottomWidth: 1,
    paddingBottom: spacing.sm,
  },
  rowHeader: { alignItems: "flex-start" },
  titleGroup: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 15, fontWeight: "600" },
  date: { color: colors.textTertiary, fontSize: 12 },
  detail: { color: colors.textSecondary, fontSize: 12 },
  history: { marginTop: spacing.xs },
  source: { color: colors.textTertiary, fontSize: 12 },
});
