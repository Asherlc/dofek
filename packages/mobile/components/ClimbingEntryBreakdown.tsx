import { formatClimbingAttemptResult } from "@dofek/format/format";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import { ChartTitleWithTooltip } from "./ChartTitleWithTooltip";

export interface ClimbingEntry {
  id: string;
  climbType: "boulder" | "route";
  grade: string;
  sent: boolean;
  attemptCount: number;
  attempts: Array<{
    attemptIndex: number;
    failureReason: "fell" | "pumped" | "skin" | "technique" | "fear" | null;
    notes: string | null;
    outcome: "sent" | "failed";
  }>;
  ascentType: "Flash" | "Onsight" | "Redpoint" | "Repeat" | null;
  holdType: "crimp" | "sloper" | "pinch" | "pocket" | "jug" | null;
  routeName: string | null;
  locationName: string | null;
  sourceName: string;
  wallAngleDegrees: number | null;
}

export function ClimbingEntryBreakdown({ entries }: { entries: ClimbingEntry[] }) {
  return (
    <View style={styles.container}>
      <ChartTitleWithTooltip
        title="Climbs"
        description="The climbs recorded during this session, including grades and send status."
        textStyle={styles.title}
      />
      {entries.map((entry) => (
        <View key={entry.id} style={styles.row}>
          <Text style={styles.grade}>{entry.grade}</Text>
          <View style={styles.details}>
            <Text style={styles.name}>
              {entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route")}
            </Text>
            {entry.locationName ? <Text style={styles.subtle}>{entry.locationName}</Text> : null}
            {entry.wallAngleDegrees !== null || entry.holdType !== null ? (
              <Text style={styles.subtle}>
                {[
                  entry.wallAngleDegrees === null ? null : `${entry.wallAngleDegrees}°`,
                  entry.holdType === null
                    ? null
                    : `${entry.holdType[0]?.toUpperCase()}${entry.holdType.slice(1)}`,
                ]
                  .filter((value) => value !== null)
                  .join(" · ")}
              </Text>
            ) : null}
            {entry.attempts.map((attempt) => (
              <Text key={attempt.attemptIndex} style={styles.subtle}>
                {attempt.attemptIndex}:{" "}
                {attempt.outcome === "sent"
                  ? "Sent"
                  : `${attempt.failureReason?.[0]?.toUpperCase()}${attempt.failureReason?.slice(1)}`}
              </Text>
            ))}
          </View>
          <View>
            {entry.ascentType ? <Text style={styles.sent}>{entry.ascentType}</Text> : null}
            <Text style={entry.sent ? styles.sent : styles.subtle}>
              {formatClimbingAttemptResult(entry.sent, entry.attemptCount)}
            </Text>
            <Text style={styles.subtle}>{entry.sourceName}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.surface, borderRadius: 16, gap: 12, padding: 16 },
  title: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  row: { alignItems: "center", flexDirection: "row", gap: 12, paddingVertical: 4 },
  grade: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
    minWidth: 48,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlign: "center",
  },
  details: { flex: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: "600" },
  subtle: { color: colors.textSecondary, fontSize: 11 },
  sent: { color: colors.positive, fontSize: 13, fontWeight: "600" },
});
