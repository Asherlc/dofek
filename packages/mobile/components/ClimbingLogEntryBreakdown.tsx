import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { StyleSheet, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard";

interface ClimbingLogEntryBreakdownProps {
  entries: readonly ClimbingLogEntryDetail[];
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  attachmentStates?: Readonly<Record<string, ClimbingLogAttachmentState>>;
  onAttach?: (entryId: string) => void;
  selectedEntryId?: string | null;
}

export function ClimbingLogEntryBreakdown({
  entries,
  locations,
  attachmentStates,
  onAttach,
  selectedEntryId,
}: ClimbingLogEntryBreakdownProps) {
  return (
    <View style={styles.grid}>
      {entries.map((entry, index) => (
        <View key={entry.id} style={styles.cell}>
          <ClimbingLogEntryCard
            entry={entry}
            location={locations?.[entry.id]}
            attachmentState={attachmentStates?.[entry.id]}
            onAttach={onAttach}
            entryNumber={index + 1}
            selected={entry.id === selectedEntryId}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  cell: { flexGrow: 1, flexShrink: 1, flexBasis: 280, minWidth: 0 },
});
