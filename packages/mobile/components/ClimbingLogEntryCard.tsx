import { formatClimbingRecordedResult } from "@dofek/format/climbing-log";
import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext";
import { ClimbingLogEntryDetails } from "./ClimbingLogEntryDetails";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";
import { RouteMap } from "./RouteMap";

export interface ClimbingLogAttachmentState {
  pending: boolean;
  error: string | null;
}

export function ClimbingLogEntryCard({
  entry,
  location,
  attachmentState,
  onAttach,
  entryNumber,
  selected = false,
}: {
  entry: ClimbingLogEntryDetail;
  location?: ClimbingMapLocation;
  attachmentState?: ClimbingLogAttachmentState;
  onAttach?: (entryId: string) => void;
  entryNumber?: number;
  selected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = entry.climb?.name ?? entry.title ?? "Climbing log";
  return (
    <View
      style={[styles.card, selected && styles.selectedCard]}
      accessibilityLabel={`Climbing entry: ${name}`}
    >
      {entryNumber != null && (
        <Text style={styles.summary}>
          Entry {entryNumber}
          {selected ? " · Selected" : ""}
        </Text>
      )}
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
      {location && (
        <View style={styles.location}>
          <Text style={styles.summary}>
            {location.scope === "area" ? "Area location" : "Climb location"}:{" "}
            {location.name ?? location.objectId} · {providerSourceLabel(location.providerId)}
          </Text>
          <RouteMap
            points={[]}
            climbMarkers={[{ entryId: entry.id, entryNumber, label: name, location }]}
            compact
          />
        </View>
      )}
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
      {onAttach && (
        <View style={styles.attachment}>
          {attachmentState?.error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {attachmentState.error}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach to this activity"
            disabled={attachmentState?.pending}
            style={styles.attachButton}
            onPress={() => onAttach(entry.id)}
          >
            <Text style={styles.attachAction}>
              {attachmentState?.pending ? "Attaching..." : "Attach"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    gap: 8,
    padding: 12,
    minWidth: 0,
    borderRadius: 12,
    backgroundColor: colors.surfaceSecondary,
  },
  selectedCard: { borderWidth: 1, borderColor: colors.accent },
  location: { gap: 6 },
  attachment: { gap: 8, alignItems: "flex-start" },
  error: { fontSize: 12, color: colors.negative },
  attachButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachAction: { color: colors.textInverse, fontSize: 13, fontWeight: "600" },
  header: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  identity: { flex: 1, gap: 4, minWidth: 0 },
  grade: { fontSize: 14, fontWeight: "600", color: colors.accent },
  summary: { fontSize: 12, color: colors.textSecondary },
  result: { fontSize: 12, color: colors.positive },
  action: { fontSize: 13, color: colors.accent },
});
