import { formatDateTime } from "@dofek/format/format";
import {
  formatSupplementDoseStatus,
  type SupplementDoseOccurrence,
} from "@dofek/format/supplement-dose-events";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";

export function SupplementDoseEventsPanel() {
  const utils = trpc.useUtils();
  const query = trpc.supplements.occurrences.useQuery({ days: 7 });
  const recordDose = trpc.supplements.recordDose.useMutation({
    onSuccess: (recorded) =>
      Promise.all([
        utils.supplements.occurrences.invalidate(),
        utils.food.byDateV2.invalidate({ date: recorded.scheduledDate }),
        utils.nutritionAnalytics.invalidate(),
      ]),
    onError: (error) => {
      captureException(error, { operation: "supplements.recordDose" });
    },
    meta: { errorReportedLocally: true },
  });

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
          disabled={recordDose.isPending}
          onRecord={(status) =>
            recordDose.mutate({
              expectedCurrentEventId: occurrence.currentEventId,
              status,
            })
          }
        />
      ))}
      {recordDose.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {recordDose.error.message}
        </Text>
      ) : null}
    </View>
  );
}

function OccurrenceRow({
  occurrence,
  disabled,
  onRecord,
}: {
  occurrence: SupplementDoseOccurrence;
  disabled: boolean;
  onRecord: (status: "taken" | "skipped") => void;
}) {
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
        <View style={styles.actions}>
          <DoseButton
            label="Taken"
            disabled={disabled || occurrence.status === "taken"}
            onPress={() => onRecord("taken")}
          />
          <DoseButton
            label="Skip"
            disabled={disabled || occurrence.status === "skipped"}
            onPress={() => onRecord("skipped")}
          />
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

function DoseButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionButton, disabled && styles.disabled]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.actionText}>{label}</Text>
    </TouchableOpacity>
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
  rowHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  titleGroup: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 15, fontWeight: "600" },
  date: { color: colors.textTertiary, fontSize: 12 },
  detail: { color: colors.textSecondary, fontSize: 12 },
  history: { marginTop: spacing.xs },
  source: { color: colors.textTertiary, fontSize: 12 },
  actions: { flexDirection: "row", gap: spacing.xs },
  actionButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  actionText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  error: { color: colors.danger, fontSize: 12 },
});
