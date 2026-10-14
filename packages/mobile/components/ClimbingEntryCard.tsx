import { formatClimbingAttemptResult } from "@dofek/format/format";
import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { ClimbingEntryContext } from "./ClimbingEntryContext";
import { ClimbingEntrySources } from "./ClimbingEntrySources";
import { RouteMap } from "./RouteMap";

type ClimbingQueries = ReturnType<typeof trpc.useUtils>["climbing"];
export type ClimbingCardEntry =
  | NonNullable<ReturnType<ClimbingQueries["activityEntries"]["getData"]>>[number]
  | NonNullable<ReturnType<ClimbingQueries["unattachedClimbingEntries"]["getData"]>>[number];

export interface ClimbingAttachmentState {
  pending: boolean;
  error: string | null;
}

interface ClimbingEntryCardProps {
  entry: ClimbingCardEntry;
  location?: ClimbingMapLocation;
  attachmentState?: ClimbingAttachmentState;
  onAttach?: (entryId: string) => void;
  entryNumber?: number;
  selected?: boolean;
}

export function ClimbingEntryCard({
  entry,
  location,
  attachmentState,
  onAttach,
  entryNumber,
  selected = false,
}: ClimbingEntryCardProps) {
  const name = entry.routeName ?? (entry.climbType === "boulder" ? "Boulder" : "Route");
  const attemptResult = formatClimbingAttemptResult(
    entry.sent,
    entry.attemptCount,
    entry.ascentType,
    entry.context,
  );
  const sourceName =
    entry.sourceName ?? ("providerId" in entry ? providerSourceLabel(entry.providerId) : null);
  return (
    <View
      style={[styles.card, selected && styles.selectedCard]}
      accessibilityLabel={`Climbing entry: ${name}`}
    >
      {entryNumber != null && (
        <Text style={styles.caption}>
          Entry {entryNumber}
          {selected ? " · Selected" : ""}
        </Text>
      )}
      <View style={styles.header}>
        <View style={styles.gradeBadge}>
          <Text style={styles.grade}>{entry.grade}</Text>
        </View>
        <View style={styles.details}>
          <ClimbingEntrySources name={name} sourceName={sourceName} links={entry.sourceLinks} />
        </View>
      </View>
      {location && (
        <View style={styles.location}>
          <Text style={styles.caption}>
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
      <ClimbingEntryContext context={entry.context} sent={entry.sent} />
      {"holdType" in entry && entry.holdType !== null && (
        <Text style={styles.caption}>
          {entry.holdType[0]?.toUpperCase()}
          {entry.holdType.slice(1)}
        </Text>
      )}
      {"attempts" in entry &&
        entry.attempts.map((attempt) => (
          <Text key={attempt.attemptIndex} style={styles.caption}>
            {attempt.attemptIndex}:{" "}
            {attempt.outcome === "sent"
              ? "Sent"
              : `${attempt.failureReason?.[0]?.toUpperCase()}${attempt.failureReason?.slice(1)}`}
          </Text>
        ))}
      {attemptResult !== null && (
        <Text style={entry.sent ? styles.sent : styles.caption}>{attemptResult}</Text>
      )}
      {onAttach && (
        <View style={styles.attachment}>
          {attachmentState?.error && <Text style={styles.error}>{attachmentState.error}</Text>}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach to this activity"
            disabled={attachmentState?.pending}
            style={styles.attachButton}
            onPress={() => onAttach(entry.id)}
          >
            <Text style={styles.attachButtonText}>
              {attachmentState?.pending ? "Attaching..." : "Attach"}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  selectedCard: { borderWidth: 1, borderColor: colors.accent },
  card: {
    minWidth: 0,
    borderRadius: 12,
    backgroundColor: colors.surfaceSecondary,
    padding: 12,
    gap: 8,
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  gradeBadge: {
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  grade: { color: colors.accent, fontSize: 14, fontWeight: "700" },
  details: { flex: 1, minWidth: 0 },
  caption: { color: colors.textSecondary, fontSize: 12, flexShrink: 1 },
  location: { gap: 6 },
  sent: { color: colors.positive, fontSize: 13, fontWeight: "600" },
  attachment: { gap: 8, alignItems: "flex-start" },
  error: { color: colors.danger, fontSize: 12 },
  attachButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  attachButtonText: { color: colors.textInverse, fontSize: 13, fontWeight: "600" },
});
