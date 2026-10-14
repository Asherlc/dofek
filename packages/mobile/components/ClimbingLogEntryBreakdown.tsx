import { formatClimbingRecordedResult } from "@dofek/format/climbing-log";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";

export function ClimbingLogEntryBreakdown({ entries }: { entries: ClimbingLogEntryDetail[] }) {
  return (
    <View style={styles.container}>
      {entries.map((entry) => (
        <ClimbingLogCard key={entry.id} entry={entry} />
      ))}
    </View>
  );
}
function ClimbingLogCard({ entry }: { entry: ClimbingLogEntryDetail }) {
  const [open, setOpen] = useState(false);
  const name = entry.climb?.name ?? entry.title ?? "Climbing log";
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <ClimbingLogEntrySources
            name={name}
            sourceName={entry.sourceName}
            links={entry.sourceLinks}
          />
          <ClimbingLogEntryContext entry={entry} />
        </View>
        {entry.displayGrade && <Text style={styles.grade}>{entry.displayGrade}</Text>}
      </View>
      {entry.recordedClimbAttemptCount > 0 && (
        <Text style={styles.summary}>
          {formatClimbingRecordedResult(
            "Whole climb",
            entry.recordedClimbOutcome,
            entry.recordedClimbAttemptCount,
          )}
        </Text>
      )}
      {entry.pitchResults.map((result) => (
        <Text key={result.attemptIds.join(":")} style={styles.summary}>
          {formatClimbingRecordedResult(
            result.pitch === null
              ? "Unidentified pitch"
              : result.pitch.number === null
                ? (result.pitch.name ?? "Pitch")
                : `Pitch ${result.pitch.number}`,
            result.recordedOutcome,
            result.recordedAttemptCount,
          )}
        </Text>
      ))}
      {entry.attempts.map(
        (attempt) =>
          attempt.rockResultLabels.length > 0 && (
            <Text key={attempt.id} style={styles.result}>
              {attempt.rockResultLabels
                .filter((label) => label !== "sent" || attempt.rockResultLabels.length === 1)
                .map((label) => (label === "sent" ? "Sent" : label))
                .join(" · ")}
            </Text>
          ),
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Details for ${name}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={styles.action}>{open ? "Hide details" : "Details"}</Text>
      </Pressable>
      {open && <ClimbingLogEntryDetails entry={entry} />}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: 12 },
  card: { gap: 8, paddingVertical: 12 },
  header: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  identity: { flex: 1, gap: 4 },
  grade: { fontSize: 14, fontWeight: "600", color: colors.accent },
  summary: { fontSize: 12, color: colors.textSecondary },
  result: { fontSize: 12, color: colors.positive },
  action: { fontSize: 13, color: colors.accent },
});
