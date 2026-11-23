import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

export type TrainingProgressionStatus = "ready" | "stagnating" | null;

export function trainingProgressionStatusLabel(status: TrainingProgressionStatus): string | null {
  if (status === "ready") return "Ready to progress";
  if (status === "stagnating") return "Stagnating";
  return null;
}

/**
 * Read-only status and evidence block shared by the Overview summary, Strength
 * evidence, and cycling Activity Detail. The server owns the status; this
 * component only formats and discloses what it is given.
 */
export function TrainingProgressionStatusCard({
  status,
  headline,
  summary,
  details,
  action,
}: {
  status: TrainingProgressionStatus;
  headline: string;
  summary: string;
  details?: ReactNode;
  action?: ReactNode;
}) {
  const label = trainingProgressionStatusLabel(status);
  return (
    <View style={styles.card}>
      <View style={styles.headlineRow}>
        <Text
          style={styles.headline}
          accessibilityLabel={`Training progression status: ${headline}`}
        >
          {headline}
        </Text>
        {label ? (
          <View style={styles.badge} accessibilityLabel={`Training status: ${label}`}>
            <Text style={styles.badgeText}>{label}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.summary}>{summary}</Text>
      {details}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 12, gap: 8, backgroundColor: colors.surface, borderRadius: 12 },
  headlineRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  headline: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  badge: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  summary: { color: colors.textSecondary, fontSize: 13 },
});
