import {
  climbingAttemptStyleLabels,
  formatClimbingRecordedResult,
  formatClimbingResultOutcome,
} from "@dofek/format/climbing-log";
import { providerSourceLabel } from "@dofek/providers/providers";
import { climbingLogEntryName } from "@dofek/training/climbing-log";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors, operationalStatusColors } from "../theme";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";
import { RouteMap } from "./RouteMap";

function ClimbingBadge({
  label,
  tone = label === "Attempted" ? "warning" : label === "Completed" ? "info" : "success",
}: {
  label: string;
  tone?: keyof typeof operationalStatusColors;
}) {
  const palette = operationalStatusColors[tone];
  return (
    <View
      style={[
        styles.resultBadge,
        { backgroundColor: palette.surface, borderColor: palette.border },
      ]}
    >
      <Text style={[styles.resultBadgeText, { color: palette.foreground }]}>{label}</Text>
    </View>
  );
}

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
  onSelect,
  onOpenEntry,
  hideMap = false,
}: {
  onSelect?: () => void;
  onOpenEntry?: () => void;
  hideMap?: boolean;
  entry: ClimbingLogEntryDetail;
  location?: ClimbingMapLocation;
  attachmentState?: ClimbingLogAttachmentState;
  onAttach?: (entryId: string) => void;
  entryNumber?: number;
  selected?: boolean;
}) {
  const name = climbingLogEntryName(entry);
  const attachmentPending = attachmentState?.pending ?? false;
  const attemptStyles = climbingAttemptStyleLabels(entry.attempts);
  const climbResultLabels = entry.attempts
    .filter((attempt) => attempt.scope === "climb")
    .flatMap((attempt) => attempt.rockResultLabels);
  const recordedOutcome =
    entry.recordedClimbAttemptCount === 0
      ? null
      : formatClimbingResultOutcome(entry.recordedClimbOutcome, climbResultLabels, entry.freeSend);
  const recordedResult =
    entry.recordedClimbAttemptCount === 0
      ? null
      : formatClimbingRecordedResult(
          null,
          null,
          entry.recordedClimbAttemptCount,
          climbResultLabels,
        );
  return (
    <View
      style={[styles.card, selected && styles.selectedCard]}
      accessibilityLabel={`Climbing entry: ${name}`}
    >
      <View style={styles.header}>
        <View style={styles.identity}>
          <ClimbingLogEntrySources
            titleControl={
              onSelect ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Select entry ${entryNumber}, ${name}`}
                  accessibilityState={{ selected }}
                  onPress={onSelect}
                  style={{ paddingVertical: 8 }}
                >
                  <Text style={styles.grade}>
                    {entryNumber}. <Text>{name}</Text>
                  </Text>
                </Pressable>
              ) : undefined
            }
            name={name}
            sourceName={entry.sourceName}
            links={entry.sourceLinks}
            selected={selected}
          />
          <ClimbingLogEntryContext entry={entry} />
        </View>
        {entry.displayGrade && <Text style={styles.grade}>{entry.displayGrade}</Text>}
      </View>
      {hideMap && (
        <Text style={styles.summary}>
          {location
            ? `${location.scope === "area" ? "Approximate area location" : "Climb location"} · ${location.name ?? location.objectId} · ${providerSourceLabel(location.providerId)}`
            : "No recorded location"}
        </Text>
      )}
      {location && !hideMap && (
        <View style={styles.location}>
          <RouteMap
            points={[]}
            climbMarkers={[{ entryId: entry.id, entryNumber, label: name, location }]}
            compact
          />
        </View>
      )}
      {attemptStyles.map((labels) => (
        <View key={labels.join(":")} style={styles.resultRow}>
          {labels.map((label) => (
            <ClimbingBadge
              key={label}
              label={label}
              tone={label === "Fell/Hung" ? "warning" : "neutral"}
            />
          ))}
        </View>
      ))}
      {(recordedOutcome || recordedResult) && (
        <View style={styles.resultRow}>
          {recordedOutcome && <ClimbingBadge label={recordedOutcome} />}
          {recordedResult && <Text style={styles.summary}>{recordedResult}</Text>}
        </View>
      )}
      {entry.pitchResults.map((result) => {
        const resultLabels = entry.attempts
          .filter((attempt) => result.attemptIds.includes(attempt.id))
          .flatMap((attempt) => attempt.rockResultLabels);
        const outcome = formatClimbingResultOutcome(result.recordedOutcome, resultLabels);
        return (
          <View key={result.attemptIds.join(":")} style={styles.resultRow}>
            <Text style={styles.summary}>
              {formatClimbingRecordedResult(
                result.pitch === null
                  ? "Unidentified pitch"
                  : result.pitch.number === null
                    ? (result.pitch.name ?? "Pitch")
                    : `Pitch ${result.pitch.number}`,
                null,
                result.recordedAttemptCount,
                resultLabels,
              )}
            </Text>
            {outcome && <ClimbingBadge label={outcome} />}
          </View>
        );
      })}
      {entry.attempts.map(
        (attempt) =>
          attempt.rockResultLabels.length > 0 && (
            <View key={attempt.id} style={styles.resultRow}>
              {attempt.rockResultLabels
                .filter((label) => label !== "sent" || attempt.rockResultLabels.length === 1)
                .map((label) => (
                  <ClimbingBadge key={label} label={label === "sent" ? "Sent" : label} />
                ))}
            </View>
          ),
      )}
      {onOpenEntry && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Details for entry ${entryNumber}, ${name}`}
          onPress={onOpenEntry}
          style={{ paddingVertical: 8 }}
        >
          <Text style={styles.grade}>Details</Text>
        </Pressable>
      )}
      {onAttach && (
        <View style={styles.attachment}>
          {attachmentState?.error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {attachmentState.error}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Attach ${entryNumber == null ? name : `entry ${entryNumber}, ${name}`} to this activity`}
            accessibilityState={{ disabled: attachmentPending, busy: attachmentPending }}
            disabled={attachmentPending}
            style={styles.attachButton}
            onPress={() => onAttach(entry.id)}
          >
            <Text style={styles.attachAction}>{attachmentPending ? "Attaching..." : "Attach"}</Text>
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
  resultRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  resultBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  resultBadgeText: { fontSize: 12, fontWeight: "600" },
});
