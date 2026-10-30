import { climbingLogEntryName } from "@dofek/training/climbing-log";
import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ClimbingLogEntryDetail } from "../../server/src/contracts/climbing-log-contracts.ts";
import { colors } from "../theme";
import { type ClimbingLogAttachmentState, ClimbingLogEntryCard } from "./ClimbingLogEntryCard";
import { RouteMap } from "./RouteMap";

const NO_POINTS: ComponentProps<typeof RouteMap>["points"] = [];
const NO_ENTRIES: readonly ClimbingLogEntryDetail[] = [];

export function ActivityClimbingPanel({
  entries,
  suggestions = NO_ENTRIES,
  attachmentStates,
  onAttach,
  locations,
  points = NO_POINTS,
  hoveredPosition,
  onOpenEntry,
  onSelectEntry,
}: {
  entries: readonly ClimbingLogEntryDetail[];
  suggestions?: readonly ClimbingLogEntryDetail[];
  attachmentStates?: Readonly<Record<string, ClimbingLogAttachmentState>>;
  onAttach?: (entryId: string) => void;
  locations: Readonly<Record<string, ClimbingMapLocation>>;
  points?: ComponentProps<typeof RouteMap>["points"];
  hoveredPosition?: ComponentProps<typeof RouteMap>["hoveredPosition"];
  onOpenEntry?: (entryId: string) => void;
  onSelectEntry?: (entryId: string | null) => void;
}) {
  const [selectedEntryId, selectEntry] = useState<string | null>(null);
  const handleSelectEntry = (entryId: string) => {
    selectEntry(entryId);
    onSelectEntry?.(entryId);
  };
  useEffect(() => {
    return () => onSelectEntry?.(null);
  }, [onSelectEntry]);
  const markers = useMemo(
    () =>
      [...entries, ...suggestions].flatMap((entry, index) => {
        const location = locations[entry.id];
        return location
          ? [
              {
                entryId: entry.id,
                entryNumber: index + 1,
                label: climbingLogEntryName(entry),
                location,
              },
            ]
          : [];
      }),
    [entries, suggestions, locations],
  );
  const sections = [
    { key: "attached", label: "Attached climbing logs", entries, offset: 0, onAttach: undefined },
    {
      key: "unattached",
      label: "Unattached climbing logs",
      entries: suggestions,
      offset: entries.length,
      onAttach,
    },
  ];
  return (
    <View style={styles.panel}>
      <RouteMap
        points={points}
        climbMarkers={markers}
        selectedEntryId={selectedEntryId}
        onSelectEntry={handleSelectEntry}
        hoveredPosition={hoveredPosition}
      />
      {sections
        .filter((section) => section.entries.length > 0)
        .map((section) => (
          <View key={section.key} accessibilityLabel={section.label} style={styles.group}>
            {section.key === "unattached" && (
              <Text accessibilityRole="header" style={styles.heading}>
                Unattached
              </Text>
            )}
            {groupClimbingLogEntriesByArea(section.entries).map(
              ({ area, entries: groupEntries }) => (
                <View key={area?.id ?? "unlocated"} style={styles.group}>
                  <Text accessibilityRole="header" style={styles.heading}>
                    {area?.name ?? "Other climbs"}
                  </Text>
                  {groupEntries.map(({ entry, entryNumber }) => (
                    <ClimbingLogEntryCard
                      key={entry.id}
                      entry={entry}
                      entryNumber={entryNumber + section.offset}
                      location={locations[entry.id]}
                      attachmentState={attachmentStates?.[entry.id]}
                      onAttach={section.onAttach}
                      hideMap
                      selected={entry.id === selectedEntryId}
                      onSelect={() => handleSelectEntry(entry.id)}
                      onOpenEntry={onOpenEntry ? () => onOpenEntry(entry.id) : undefined}
                    />
                  ))}
                </View>
              ),
            )}
          </View>
        ))}
      {entries.length === 0 && suggestions.length === 0 && (
        <Text style={styles.heading}>No climbing logs attached to this activity.</Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 16, minWidth: 0 },
  group: { gap: 8 },
  heading: { fontSize: 14, fontWeight: "600", color: colors.text },
});
