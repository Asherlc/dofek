import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
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
    <View style={styles.groups}>
      {groupClimbingLogEntriesByArea(entries).map(({ area, entries: groupEntries }) => (
        <View key={area?.id ?? "unlocated"} accessibilityLabel={area?.name} style={styles.group}>
          {area && (
            <Text accessibilityRole="header" style={styles.heading}>
              {area.name}
            </Text>
          )}
          <View style={styles.grid}>
            {groupEntries.map(({ entry, entryNumber }) => (
              <View key={entry.id} style={styles.cell}>
                <ClimbingLogEntryCard
                  entry={entry}
                  location={locations?.[entry.id]}
                  attachmentState={attachmentStates?.[entry.id]}
                  onAttach={onAttach}
                  entryNumber={entryNumber}
                  selected={entry.id === selectedEntryId}
                />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  groups: { gap: 16 },
  group: { gap: 8 },
  heading: { color: colors.text, fontSize: 14, fontWeight: "600" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  cell: { flexGrow: 1, flexShrink: 1, flexBasis: 280, minWidth: 0 },
});
