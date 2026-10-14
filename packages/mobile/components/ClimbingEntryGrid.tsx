import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { StyleSheet, View } from "react-native";
import {
  type ClimbingAttachmentState,
  type ClimbingCardEntry,
  ClimbingEntryCard,
} from "./ClimbingEntryCard";

interface ClimbingEntryGridProps {
  entries: readonly ClimbingCardEntry[];
  locations?: Readonly<Record<string, ClimbingMapLocation>>;
  attachmentStates?: Readonly<Record<string, ClimbingAttachmentState>>;
  onAttach?: (entryId: string) => void;
  selectedEntryId?: string | null;
}

export function ClimbingEntryGrid({
  entries,
  locations,
  attachmentStates,
  onAttach,
  selectedEntryId,
}: ClimbingEntryGridProps) {
  return (
    <View style={styles.grid}>
      {entries.map((entry, index) => (
        <View key={entry.id} style={styles.cell}>
          <ClimbingEntryCard
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
