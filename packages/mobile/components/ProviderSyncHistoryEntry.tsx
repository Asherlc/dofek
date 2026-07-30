import { formatDurationSeconds, formatTime } from "@dofek/format/format";
import {
  type ProviderSyncLogTone,
  providerSyncLogPresentation,
} from "@dofek/providers/sync-log-presentation";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, fonts, radius, spacing } from "../theme";

export interface ProviderSyncHistoryEntryData {
  id: string;
  syncedAt: string;
  dataType: string;
  status: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  authFailureReason: string | null;
}

interface ProviderSyncHistoryEntryProps {
  providerName: string;
  entry: ProviderSyncHistoryEntryData;
}

export function ProviderSyncHistoryEntry({ providerName, entry }: ProviderSyncHistoryEntryProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const presentation = providerSyncLogPresentation({
    providerName,
    dataType: entry.dataType,
    status: entry.status,
    authFailureReason: entry.authFailureReason,
  });

  return (
    <View style={[styles.container, borderStyleByTone[presentation.tone]]}>
      <View style={styles.header}>
        <View style={styles.summary}>
          <Text style={styles.dataType}>{presentation.dataTypeLabel}</Text>
          <Text style={styles.heading}>{presentation.heading}</Text>
          {presentation.message ? <Text style={styles.message}>{presentation.message}</Text> : null}
        </View>
        <Text style={styles.time}>{formatTime(entry.syncedAt)}</Text>
      </View>

      <View style={styles.metadata}>
        <Text style={styles.metadataText}>{entry.recordCount ?? "—"} records</Text>
        {entry.durationMs !== null ? (
          <Text style={styles.metadataText}>{formatDurationSeconds(entry.durationMs / 1000)}</Text>
        ) : null}
      </View>

      <TouchableOpacity
        onPress={() => setShowDiagnostics((visible) => !visible)}
        accessibilityRole="button"
        accessibilityLabel={showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
        accessibilityState={{ expanded: showDiagnostics }}
        activeOpacity={0.7}
      >
        <Text style={styles.diagnosticsButton}>
          {showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
        </Text>
      </TouchableOpacity>

      {showDiagnostics ? (
        <View style={styles.diagnostics}>
          <DiagnosticValue label="Data type" value={entry.dataType} />
          <DiagnosticValue label="Status" value={entry.status} />
          {entry.authFailureReason ? (
            <DiagnosticValue label="Authorization reason" value={entry.authFailureReason} />
          ) : null}
          {entry.errorMessage ? <DiagnosticValue label="Error" value={entry.errorMessage} /> : null}
          <DiagnosticValue label="Log ID" value={entry.id} />
        </View>
      ) : null}
    </View>
  );
}

function DiagnosticValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.diagnosticRow}>
      <Text style={styles.diagnosticLabel}>{label}</Text>
      <Text style={styles.diagnosticValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderLeftWidth: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.sm,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  summary: { flex: 1 },
  dataType: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  heading: { color: colors.text, fontSize: 14, fontWeight: "700" },
  message: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },
  time: { color: colors.textTertiary, fontSize: 11 },
  metadata: { flexDirection: "row", gap: spacing.md },
  metadataText: { color: colors.textSecondary, fontSize: 12 },
  diagnosticsButton: { color: colors.accent, fontSize: 12, fontWeight: "600", paddingVertical: 2 },
  diagnostics: {
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  diagnosticRow: { gap: 2 },
  diagnosticLabel: { color: colors.textTertiary, fontSize: 11 },
  diagnosticValue: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: 11 },
});

const borderStyleByTone: Record<ProviderSyncLogTone, { borderLeftColor: string }> = {
  success: { borderLeftColor: colors.positive },
  warning: { borderLeftColor: colors.warning },
  danger: { borderLeftColor: colors.danger },
};
